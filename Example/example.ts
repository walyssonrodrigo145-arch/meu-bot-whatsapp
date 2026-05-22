import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { CacheStore, DEFAULT_CONNECTION_CONFIG, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, generateMessageIDV2, getAggregateVotesInPollMessage, isJidNewsletter, makeCacheableSignalKeyStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'

const logger = P({
  level: "info", // altered to info to reduce noise on SaaS multi-session logs, but keep trace optional
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "info",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})

const doReplies = process.argv.includes('--do-reply')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

// --- MULTI-SESSION ARCHITECTURE SETUP ---
interface SessionData {
    sock: any;
    status: 'PAIRING' | 'CONNECTED' | 'DISCONNECTED';
    qr?: string;
    pairingCode?: string;
    phoneNumber?: string;
    isClosing?: boolean;
    paired?: boolean;
}

const sessions = new Map<string, SessionData>()

// Helper to resolve session directory path
const getAuthPath = (sessionId: string) => {
	return path.join('baileys_auth_info', sessionId)
}

// Start a connection for a specific sessionId
const startSock = async (sessionId: string, phoneNumber?: string, isNewPairingRequest?: boolean): Promise<string | undefined> => {
	// 1. Terminate any pre-existing session and clean up to prevent port or resource leaks
	const existingSession = sessions.get(sessionId)
	const previousPhone = phoneNumber || existingSession?.phoneNumber
	const previousPairingCode = existingSession?.pairingCode
	const previousQr = existingSession?.qr

	if (existingSession) {
		if (existingSession.status === 'CONNECTED') {
			logger.info(`Sessão [${sessionId}] já conectada. Evitando reinicialização redundante.`)
			return
		}
		
		logger.info(`Encerrando conexão socket antiga e pendente para o sessionId: ${sessionId}`)
		existingSession.isClosing = true // Marca explicitamente para ignorar loops de reconexão fantasma
		try {
			if (existingSession.sock) {
				existingSession.sock.ev.removeAllListeners('connection.update')
				existingSession.sock.ev.removeAllListeners('creds.update')
				existingSession.sock.end(undefined)
			}
		} catch (e) {
			logger.error(e, `Erro ao encerrar socket antigo da sessão ${sessionId}`)
		}
		sessions.delete(sessionId)
	}

	const sessionDir = getAuthPath(sessionId)

	// SÓ LIMPA O DISCO SE FOR UMA NOVA REQUISIÇÃO EXPLÍCITA DA API (/sessions/start)!!!
	// JAMAIS LIMPA O DISCO DURANTE AS RECONEXÕES INTERNAS DO SOCKET!!!
	if (isNewPairingRequest && fs.existsSync(sessionDir)) {
		try {
			fs.rmSync(sessionDir, { recursive: true, force: true })
			logger.info(`Limpeza de credenciais antigas no disco concluída para a nova requisição de pareamento: ${sessionId}`)
		} catch (e) {
			logger.error(e, `Erro ao limpar diretório físico para pareamento: ${sessionId}`)
		}
	}

	// Garante a existência do diretório pai
	if (!fs.existsSync('baileys_auth_info')) {
		fs.mkdirSync('baileys_auth_info', { recursive: true })
	}

	// Inicializa o estado de autenticação de arquivos multi-pasta
	const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

	if (process.env.ADV_SECRET_KEY) {
		state.creds.advSecretKey = process.env.ADV_SECRET_KEY
	}

	const { version, isLatest } = await fetchLatestWaWebVersion()
	logger.info({ version: version.join('.'), isLatest }, `Iniciando socket Baileys para sessionId: [${sessionId}]`)

	const sock = makeWASocket({
		version,
		browser: ['Ubuntu', 'Chrome', '22.04.4'], // Formato exigido pelo WhatsApp: [OS, Browser, Version]
		logger,
		browser: ['Ubuntu', 'Chrome', '110.0.0'],
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		getMessage
	})

	// Inicializa o mapa com a nova sessão preservando os dados anteriores
	sessions.set(sessionId, {
		sock,
		status: 'PAIRING',
		phoneNumber: previousPhone,
		pairingCode: previousPairingCode,
		qr: previousQr,
		isClosing: false,
		paired: false
	})

	let pairingCodePromise: Promise<string> | undefined
	if (previousPhone && !sock.authState.creds.registered) {
		logger.info(`Aguardando abertura real do túnel WebSocket e handshake Noise para solicitar código de pareamento para ${previousPhone}...`)
		pairingCodePromise = new Promise(async (resolve, reject) => {
			try {
				// 1. Aguarda a abertura oficial do socket via método nativo do Baileys
				await sock.waitForSocketOpen()
				logger.info(`Túnel WebSocket aberto. Aguardando 1500ms para conclusão do handshake criptográfico Noise...`)
				
				// 2. Aguarda 1500ms para garantir que o servidor do WhatsApp concluiu o registro inicial e o Noise está sincronizado
				await new Promise(r => setTimeout(r, 1500))

				logger.info(`Solicitando código de pareamento de 8 dígitos para o número ${previousPhone}...`)
				const code = await sock.requestPairingCode(previousPhone)
				const current = sessions.get(sessionId)
				if (current && !current.isClosing) {
					current.pairingCode = code
					current.status = 'PAIRING'
				}
				logger.info(`\n\n---> CÓDIGO DE PAREAMENTO WHATSAPP PARA [${sessionId}]: ${code} <---\n\n`)
				resolve(code)
			} catch (err) {
				logger.error(err, `Erro ao solicitar código de pareamento para ${sessionId}`)
				reject(err)
			}
		})
	}

	sock.ev.process(
		async (events) => {
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				const current = sessions.get(sessionId)

				// Se a sessão foi marcada para encerramento intencional, ignora qualquer processamento
				if (current?.isClosing) {
					logger.info(`Sessão [${sessionId}] ignorando connection.update de encerramento intencional.`)
					return
				}

				if (update.isNewLogin && current) {
					current.paired = true
					logger.info(`Sessão [${sessionId}] pareada com sucesso! Aguardando reconexão de login...`)
				}

				if (qr && current) {
					current.qr = qr
					current.status = 'PAIRING'
					logger.info(`Sessão [${sessionId}]: Novo QR Code gerado com sucesso.`)
				}

				if (connection === 'open') {
					logger.info(`Sessão do professor [${sessionId}] CONECTADA com sucesso!`)
					if (current) {
						current.status = 'CONNECTED'
						current.pairingCode = undefined
						current.qr = undefined
						if (sock.user?.id) {
							current.phoneNumber = sock.user.id.split(':')[0]
						}
					}
				}

				if (connection === 'close') {
					const err = lastDisconnect?.error
					const statusCode = (err as Boom)?.output?.statusCode
					const errMsg = err?.message || ''

					const isLoggedOut = statusCode === DisconnectReason.loggedOut || errMsg.includes('401') || errMsg.includes('logged out')

					// O WhatsApp Web encerra o socket de pareamento com erro 401/500 logo após o sucesso do código.
					// Só limpamos o disco se for um deslogamento real de uma sessão que JÁ ESTAVA conectada (não em pareamento!)
					// ou se o pareamento falhou (erro 401 e não marcou 'paired' como true)
					if (isLoggedOut && (current?.status !== 'PAIRING' || !current?.paired)) {
						logger.warn(`Sessão [${sessionId}] foi deslogada ou pareamento falhou (Erro 401). Limpando dados do disco...`)
						try {
							if (fs.existsSync(sessionDir)) {
								fs.rmSync(sessionDir, { recursive: true, force: true })
							}
						} catch (e) {
							logger.error(e, `Erro ao limpar arquivos da pasta ${sessionDir}`)
						}
						sessions.delete(sessionId)
					} else {
						// Erro de rede temporário ou reinício pós-pareamento. Tenta restabelecer a conexão mantendo as chaves intactas
						logger.info(`Sessão [${sessionId}] desconectada (status anterior: ${current?.status}). Tentando restabelecer conexão em 3s...`)
						setTimeout(() => {
							const checkSess = sessions.get(sessionId)
							if (checkSess && !checkSess.isClosing && checkSess.status !== 'CONNECTED') {
								startSock(sessionId, checkSess.phoneNumber).catch(() => {})
							}
						}, 3000)
					}
				}

				logger.debug(update, `Connection update para sessionId: ${sessionId}`)
			}

			if (events['creds.update']) {
				const current = sessions.get(sessionId)
				if (!current?.isClosing) {
					await saveCreds()
					logger.debug({}, `Credenciais salvas no disco para sessionId: ${sessionId}`)
				}
			}

			// Resposta automática de teste opcional (ativado por flag --do-reply)
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				if (upsert.type === 'notify' && doReplies) {
					for (const msg of upsert.messages) {
						if (!msg.key.fromMe && !isJidNewsletter(msg.key?.remoteJid!)) {
							const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
							if (text === 'ping') {
								const id = generateMessageIDV2(sock.user?.id)
								await sock.sendMessage(msg.key.remoteJid!, { text: 'pong' }, { messageId: id })
							}
						}
					}
				}
			}
		}
	)

	if (pairingCodePromise) {
		return await pairingCodePromise
	}
	return undefined

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		return proto.Message.create({ conversation: 'test' })
	}
}

// --- ROTINA DE RESTAURO AUTOMÁTICO (BOOT) ---
const restoreSessions = async () => {
	if (!fs.existsSync('baileys_auth_info')) {
		fs.mkdirSync('baileys_auth_info', { recursive: true })
		return
	}
	const dirs = fs.readdirSync('baileys_auth_info')
	for (const dir of dirs) {
		const fullPath = path.join('baileys_auth_info', dir)
		if (fs.statSync(fullPath).isDirectory()) {
			logger.info(`[BOOT] Restaurando sessão anterior ativa do professor: ${dir}`)
			startSock(dir).catch(err => {
				logger.error(err, `Erro ao restaurar sessão de inicialização rápida para ${dir}`)
			})
		}
	}
}

// Executa o boot automático
restoreSessions().then(() => {
	logger.info('Rotina de restauro automático de sessões em andamento (segundo plano).')
}).catch(err => {
	logger.error(err, 'Erro na inicialização da rotina de boot automático')
})


// --- CONFIGURAÇÃO DA API EXPRESS MULTI-SESSÃO ---
const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static('public')) // Serve a interface web premium estática na raiz

const expectedApiKey = process.env.API_KEY ?? 'minha_chave_secreta_123'

// Middleware simples de autenticação
const validateApiKey = (req: any, res: any) => {
	const { apiKey } = req.body
	if (apiKey !== expectedApiKey) {
		res.status(401).json({ error: 'Acesso não autorizado. Chave de API inválida.' })
		return false
	}
	return true
}

// 1. Iniciar ou Reiniciar Pareamento (POST /sessions/start)
app.post('/sessions/start', async (req: any, res: any) => {
	try {
		if (!validateApiKey(req, res)) return

		const { sessionId, phoneNumber } = req.body
		if (!sessionId) {
			return res.status(400).json({ error: 'Parâmetro "sessionId" é obrigatório.' })
		}

		// Formata o número se fornecido com as regras do 9º dígito no Brasil
		let cleanNumber: string | undefined = undefined
		if (phoneNumber) {
			cleanNumber = String(phoneNumber).replace(/\D/g, '')
			if (!cleanNumber.startsWith('55')) {
				cleanNumber = '55' + cleanNumber
			}
			// Regras para números brasileiros (DDI 55)
			if (cleanNumber.startsWith('55')) {
				if (cleanNumber.length === 13) {
					const ddd = parseInt(cleanNumber.slice(2, 4), 10)
					// DDDs de 11 a 28 possuem o 9º dígito. Fora dessa faixa, o 9º dígito deve ser removido no JID
					if (ddd < 11 || ddd > 28) {
						cleanNumber = cleanNumber.slice(0, 4) + cleanNumber.slice(5)
					}
				} else if (cleanNumber.length === 12) {
					const ddd = parseInt(cleanNumber.slice(2, 4), 10)
					// DDDs de 11 a 28 devem possuir o 9º dígito. Adiciona se não estiver presente
					if (ddd >= 11 && ddd <= 28) {
						cleanNumber = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4)
					}
				}
			}
		}

		// Se já está conectado e pronto
		const sess = sessions.get(sessionId)
		if (sess && sess.status === 'CONNECTED') {
			return res.status(200).json({
				success: true,
				sessionId,
				status: 'CONNECTED',
				phone: sess.phoneNumber,
				message: 'WhatsApp já está conectado e pronto para disparos.'
			})
		}

		// Trava de ouro inteligente: Se a sessão já está em pareamento (aguardando QR ou Código), não derruba o socket ativo!
		// EXCEÇÃO CRÍTICA: Se o usuário pediu Código de Pareamento (cleanNumber existe) mas a sessão ativa não tem pairingCode gerado
		// (ex: foi iniciada pelo boot automático no modo QR), ignoramos a trava para forçar a geração do Código de Pareamento!
		const isRequestingCodeButNoCodeExists = cleanNumber && !sess.pairingCode;

		if (sess && sess.status === 'PAIRING' && sess.sock && !sess.isClosing && !isRequestingCodeButNoCodeExists) {
			logger.info(`Sessão [${sessionId}] já está em processo de pareamento. Retornando dados ativos sem reiniciar socket...`)
			return res.status(200).json({
				success: true,
				sessionId,
				status: 'PAIRING',
				mode: sess.pairingCode ? 'PAIRING_CODE' : (sess.qr ? 'QR_CODE' : 'NONE'),
				pairingCode: sess.pairingCode,
				qr: sess.qr,
				message: sess.pairingCode ? 'Código já gerado. Digite no celular.' : 'QR Code já ativo. Escaneie com o celular.'
			})
		}

		logger.info(`Iniciando pareamento para a sessão [${sessionId}] (Modo: ${cleanNumber ? 'Código de Pareamento' : 'QR Code'})...`)
		const code = await startSock(sessionId, cleanNumber, true)

		if (!cleanNumber) {
			// Polling inteligente: aguarda até 6 segundos (30 tentativas de 200ms) pela geração do QR Code no connection.update
			let attempts = 0
			let qrCode: string | undefined = undefined
			while (attempts < 30) {
				const checkSess = sessions.get(sessionId)
				if (checkSess?.qr) {
					qrCode = checkSess.qr
					break
				}
				await new Promise(r => setTimeout(r, 200))
				attempts++
			}

			const updatedSess = sessions.get(sessionId)
			return res.status(200).json({
				success: true,
				sessionId,
				status: 'PAIRING',
				mode: 'QR_CODE',
				qr: qrCode || updatedSess?.qr,
				message: (qrCode || updatedSess?.qr) ? 'QR Code gerado com sucesso. Escaneie com o celular.' : 'Aguardando geração do QR Code. Consulte /sessions/status.'
			})
		}

		return res.status(200).json({
			success: true,
			sessionId,
			status: 'PAIRING',
			mode: 'PAIRING_CODE',
			pairingCode: code,
			message: 'Código gerado com sucesso. Digite no celular em até 60 segundos.'
		})
	} catch (error: any) {
		logger.error(error, `Erro ao iniciar pareamento para o sessionId: ${req.body?.sessionId}`)
		return res.status(500).json({ error: 'Falha ao iniciar pareamento do WhatsApp', details: error.message })
	}
})

// Helper de Timeout para Promessas
const promiseWithTimeout = <T>(promise: Promise<T>, ms: number, errorMsg = 'Timeout'): Promise<T> => {
	const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
	return Promise.race([promise, timeout])
}

// 2. Consultar Status da Conexão (POST /sessions/status)
app.post('/sessions/status', async (req: any, res: any) => {
	try {
		if (!validateApiKey(req, res)) return

		const { sessionId } = req.body
		if (!sessionId) {
			return res.status(400).json({ error: 'Parâmetro "sessionId" é obrigatório.' })
		}

		const sess = sessions.get(sessionId)
		if (!sess) {
			return res.status(404).json({
				sessionId,
				status: 'DISCONNECTED',
				message: 'Sessão inexistente ou não inicializada.'
			})
		}

		let realStatus = sess.status

		// Se a sessão consta como CONNECTED, fazemos uma validação ativa e em tempo real
		if (realStatus === 'CONNECTED') {
			if (!sess.sock) {
				realStatus = 'DISCONNECTED'
			} else {
				// Tenta uma consulta leve na rede do WhatsApp para garantir chaves e tokens ativos
				const ownJid = sess.sock.user?.id
				if (ownJid) {
					try {
						// Consulta se o próprio número existe no WhatsApp (verificação rápida que bate no servidor do WhatsApp)
						const [result] = await promiseWithTimeout(sess.sock.onWhatsApp(ownJid), 3000, 'WhatsApp connection timeout')
						if (!result || !result.exists) {
							logger.warn(`Sessão [${sessionId}] falhou ao validar número próprio na rede do WhatsApp.`)
							realStatus = 'DISCONNECTED'
						}
					} catch (err: any) {
						logger.warn(`Erro de validação ativa para a sessão [${sessionId}]: ${err.message}. Marcando como inativa/zumbi.`)
						realStatus = 'DISCONNECTED'
					}
				} else {
					realStatus = 'DISCONNECTED'
				}
			}

			// Se a validação falhou, atualiza o status interno para evitar retentativas infrutíferas
			if (realStatus === 'DISCONNECTED') {
				sess.status = 'DISCONNECTED'
			}
		}

		return res.status(200).json({
			sessionId,
			status: realStatus,
			phone: sess.phoneNumber,
			pairingCode: sess.pairingCode,
			qr: sess.qr,
			mode: sess.pairingCode ? 'PAIRING_CODE' : (sess.qr ? 'QR_CODE' : 'NONE'),
			message: realStatus === 'CONNECTED'
				? 'WhatsApp conectado e pronto para disparos.'
				: (realStatus === 'PAIRING' ? (sess.pairingCode ? 'Aguardando digitação do código no celular.' : 'Aguardando escaneamento do QR Code.') : 'Sessão desconectada ou zumbi (necessário reconectar).')
		})
	} catch (error: any) {
		logger.error(error, `Erro ao consultar status da sessão: ${req.body?.sessionId}`)
		return res.status(500).json({ error: 'Falha ao consultar status da sessão', details: error.message })
	}
})

// 3. Disparar Lembrete (POST /send-message e POST / para compatibilidade com sistema legado)
const handleSendMessage = async (req: any, res: any) => {
	try {
		if (!validateApiKey(req, res)) return

		const { sessionId, number, message } = req.body

		if (!sessionId || !number || !message) {
			return res.status(400).json({ error: 'Os parâmetros "sessionId", "number" e "message" são estritamente obrigatórios.' })
		}

		const sess = sessions.get(sessionId)
		if (!sess || sess.status !== 'CONNECTED' || !sess.sock) {
			return res.status(503).json({ error: `Sessão [${sessionId}] do WhatsApp não está ativa ou não existe.` })
		}

		const sock = sess.sock

		// Limpa caracteres do número
		let cleanNumber = String(number).replace(/\D/g, '')
		if (!cleanNumber.startsWith('55')) {
			cleanNumber = '55' + cleanNumber
		}
		let jid = `${cleanNumber}@s.whatsapp.net`

		// Valida se o número é oficial no WhatsApp
		// onWhatsApp pode retornar undefined se o servidor não trouxer resultados; usamos ?? [] para evitar TypeError no destructuring
		let [waExists] = (await sock.onWhatsApp(jid)) ?? []

		if (!waExists?.exists && cleanNumber.startsWith('55') && cleanNumber.length === 13) {
			// Tenta remover o dígito 9 após o DDD se for 13 dígitos
			const semNove = cleanNumber.slice(0, 4) + cleanNumber.slice(5)
			const [waExistsSemNove] = (await sock.onWhatsApp(`${semNove}@s.whatsapp.net`)) ?? []
			if (waExistsSemNove?.exists) {
				jid = waExistsSemNove.jid
				waExists = waExistsSemNove
			}
		} else if (!waExists?.exists && cleanNumber.startsWith('55') && cleanNumber.length === 12) {
			// Tenta adicionar o dígito 9 após o DDD se for 12 dígitos
			const comNove = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4)
			const [waExistsComNove] = (await sock.onWhatsApp(`${comNove}@s.whatsapp.net`)) ?? []
			if (waExistsComNove?.exists) {
				jid = waExistsComNove.jid
				waExists = waExistsComNove
			}
		}

		if (waExists?.exists) {
			jid = waExists.jid
			logger.info({ jid }, `JID oficial validado com sucesso via WhatsApp para a sessão ${sessionId}`)
		} else {
			logger.warn({ jid }, `Aviso: Número não validado no onWhatsApp, enviando por fallback para a sessão ${sessionId}...`)
		}

		// Dispara a mensagem
		const sentMsg = await sock.sendMessage(jid, { text: message })
		logger.info({ jid }, `Lembrete enviado com sucesso pela sessão ${sessionId}`)

		return res.status(200).json({ success: true, sessionId, messageId: sentMsg?.key?.id })
	} catch (error: any) {
		logger.error(error, `Erro ao disparar lembrete via API para a sessão: ${req.body?.sessionId || 'desconhecida'}`)
		return res.status(500).json({ error: 'Falha ao enviar mensagem', details: error.message })
	}
}

app.post('/send-message', handleSendMessage)
app.post('/', handleSendMessage)

// 4. Encerrar e Deletar Sessão (POST /sessions/logout)
app.post('/sessions/logout', async (req: any, res: any) => {
	try {
		if (!validateApiKey(req, res)) return

		const { sessionId } = req.body
		if (!sessionId) {
			return res.status(400).json({ error: 'Parâmetro "sessionId" é obrigatório.' })
		}

		const sess = sessions.get(sessionId)
		if (sess) {
			try {
				if (sess.sock) {
					sess.sock.ev.removeAllListeners('connection.update')
					sess.sock.ev.removeAllListeners('creds.update')
					await sess.sock.logout().catch(() => {})
				}
			} catch (e) {}
			sessions.delete(sessionId)
		}

		// Remove os arquivos físicos da sessão deslogada permanentemente
		const sessionDir = getAuthPath(sessionId)
		if (fs.existsSync(sessionDir)) {
			try {
				fs.rmSync(sessionDir, { recursive: true, force: true })
				logger.info(`Arquivos da pasta de autenticação da sessão deslogada foram removidos: ${sessionId}`)
			} catch (e) {
				logger.error(e, `Erro ao limpar arquivos físicos da sessão deslogada ${sessionId}`)
			}
		}

		return res.status(200).json({ success: true, message: 'Sessão encerrada e arquivos removidos com sucesso.' })
	} catch (error: any) {
		logger.error(error, `Erro ao encerrar sessão: ${req.body?.sessionId}`)
		return res.status(500).json({ error: 'Falha ao encerrar sessão', details: error.message })
	}
})

// 5. Listar Todas as Sessões Ativas e Gravadas (POST /sessions/list)
app.post('/sessions/list', async (req: any, res: any) => {
	try {
		if (!validateApiKey(req, res)) return

		const list: any[] = []

		// 1. Pega as sessões ativas na memória RAM
		for (const [sessionId, sess] of sessions.entries()) {
			list.push({
				sessionId,
				status: sess.status,
				phone: sess.phoneNumber,
				pairingCode: sess.pairingCode,
				qr: sess.qr,
				mode: sess.pairingCode ? 'PAIRING_CODE' : (sess.qr ? 'QR_CODE' : 'NONE'),
			})
		}

		// 2. Verifica também as pastas no disco (baileys_auth_info) para incluir sessões descarregadas ou em boot
		if (fs.existsSync('baileys_auth_info')) {
			const dirs = fs.readdirSync('baileys_auth_info')
			for (const dir of dirs) {
				if (!sessions.has(dir)) {
					const fullPath = path.join('baileys_auth_info', dir)
					if (fs.statSync(fullPath).isDirectory()) {
						list.push({
							sessionId: dir,
							status: 'DISCONNECTED',
							message: 'Sessão gravada no disco (inativa na memória).'
						})
					}
				}
			}
		}

		return res.status(200).json({ success: true, sessions: list })
	} catch (error: any) {
		logger.error(error, 'Erro ao listar sessões no /sessions/list')
		return res.status(500).json({ error: 'Falha ao listar sessões', details: error.message })
	}
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
    logger.info(`Servidor da API Express Multi-Sessão rodando na porta ${PORT}`)
})
