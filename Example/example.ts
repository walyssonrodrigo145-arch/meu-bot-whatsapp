import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { CacheStore, DEFAULT_CONNECTION_CONFIG, DisconnectReason, fetchLatestBaileysVersion, generateMessageIDV2, getAggregateVotesInPollMessage, isJidNewsletter, makeCacheableSignalKeyStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import express from 'express'
import cors from 'cors'
import fs from 'fs'

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// Instância global do socket para a API Express
let currentSock: any = null

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// NOTE: For unit testing purposes only
	if (process.env.ADV_SECRET_KEY) {
		state.creds.advSecretKey = process.env.ADV_SECRET_KEY
	}
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	logger.debug({version: version.join('.'), isLatest}, `using latest WA version`)

	const sock = makeWASocket({
		version,
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage
	})

	currentSock = sock

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if(connection === 'close') {
					const err = lastDisconnect?.error
					const statusCode = (err as Boom)?.output?.statusCode
					const errMsg = err?.message || ''

					// Verifica se é erro 401 (logged out) ou falha de conexão por chaves corrompidas
					if(statusCode === DisconnectReason.loggedOut || errMsg.includes('401') || errMsg.includes('Connection failure') || errMsg.includes('logged out')) {
						logger.fatal('Sessão inválida ou corrompida (Erro 401 / Falha de Conexão). Limpando arquivos internos do volume...')
						try {
							const files = fs.readdirSync('baileys_auth_info')
							for (const file of files) {
								fs.rmSync(`baileys_auth_info/${file}`, { recursive: true, force: true })
							}
							logger.info('Arquivos corrompidos do volume limpos com sucesso!')
						} catch (e: any) {
							logger.error(e, 'Erro ao limpar arquivos do volume')
						}
						setTimeout(() => startSock(), 2000)
					} else {
						startSock()
					}
				}

				if (qr && !sock.authState.creds.registered) {
					// Ignora o QR code distorcido da nuvem e solicita o Código de Pareamento
					const phoneNumber = '553399958830'
					try {
						const code = await sock.requestPairingCode(phoneNumber)
						logger.info(`\n\n---> CÓDIGO DE PAREAMENTO DO WHATSAPP: ${code} <---\n\n`)
					} catch (err) {
						logger.error(err, 'Falha ao solicitar código de pareamento')
					}
				}

				logger.debug(update, 'connection update')
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
				logger.debug({}, 'creds save triggered')
			}

			if(events['labels.association']) {
				logger.debug(events['labels.association'], 'labels.association event fired')
			}


			if(events['labels.edit']) {
				logger.debug(events['labels.edit'], 'labels.edit event fired')
			}

			if(events['call']) {
				logger.debug(events['call'], 'call event fired')
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					logger.debug(messages, 'received on-demand history sync')
				}
				logger.debug({contacts: contacts.length, chats: chats.length, messages: messages.length, isLatest, progress, syncType: syncType?.toString() }, 'messaging-history.set event fired')
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.debug(upsert, 'messages.upsert fired')

        if (!!upsert.requestId) {
          logger.debug(upsert, 'placeholder request message received')
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
								logger.debug({ id: messageId }, 'requested placeholder resync')
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                logger.debug({ id: messageId }, 'requested on-demand history resync')
              }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
              	const id = generateMessageIDV2(sock.user?.id)
              	logger.debug({id, orig_id: msg.key.id }, 'replying to message')
                await sock.sendMessage(msg.key.remoteJid!, { text: 'pong '+msg.key.id }, {messageId: id })
              }
            }
          }
        }
      }

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				logger.debug(events['messages.update'], 'messages.update fired')

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if(pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if(events['message-receipt.update']) {
				logger.debug(events['message-receipt.update'])
			}

			if (events['contacts.upsert']) {
				logger.debug(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				logger.debug(events['messages.reaction'])
			}

			if(events['presence.update']) {
				logger.debug(events['presence.update'])
			}

			if(events['chats.update']) {
				logger.debug(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						logger.debug({id: contact.id, newUrl}, `contact has a new profile pic` )
					}
				}
			}

			if(events['chats.delete']) {
				logger.debug('chats deleted ', events['chats.delete'])
			}

			if(events['group.member-tag.update']) {
				logger.debug('group member tag update', JSON.stringify(events['group.member-tag.update'], undefined, 2))
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
	  // Implement a way to retreive messages that were upserted from messages.upsert
			// up to you

		// only if store is present
		return proto.Message.create({ conversation: 'test' })
	}
}

startSock()

// --- CONFIGURAÇÃO DA API EXPRESS PARA DISPARO DE LEMBRETES ---
const app = express()
app.use(cors())
app.use(express.json())

// Rota POST para disparar mensagens do seu site
app.post('/send-message', async (req: any, res: any) => {
    try {
        const { number, message, apiKey } = req.body

        // Verificação simples de segurança (Proteção da API)
        // Você pode configurar a variável API_KEY no Fly.io (fly secrets set API_KEY=sua_senha)
        const expectedApiKey = process.env.API_KEY ?? 'minha_chave_secreta_123'
        if (apiKey !== expectedApiKey) {
            return res.status(401).json({ error: 'Acesso não autorizado. Chave de API inválida.' })
        }

        if (!number || !message) {
            return res.status(400).json({ error: 'Parâmetros "number" e "message" são obrigatórios.' })
        }

        if (!currentSock) {
            return res.status(503).json({ error: 'Bot do WhatsApp ainda não está pronto ou conectado.' })
        }

        // Formata o número limpando caracteres
        let cleanNumber = number.replace(/\D/g, '')
        if (!cleanNumber.startsWith('55')) {
            cleanNumber = '55' + cleanNumber
        }
        let jid = `${cleanNumber}@s.whatsapp.net`

        // Consulta o WhatsApp para descobrir o JID oficial exato (com ou sem o 9)
        let [waExists] = await currentSock.onWhatsApp(jid)

        if (!waExists?.exists && cleanNumber.startsWith('55') && cleanNumber.length === 13) {
            // Se tem 13 dígitos (ex: 55 33 98896-2572), tenta remover o 9 após o DDD
            const semNove = cleanNumber.slice(0, 4) + cleanNumber.slice(5)
            const [waExistsSemNove] = await currentSock.onWhatsApp(`${semNove}@s.whatsapp.net`)
            if (waExistsSemNove?.exists) {
                jid = waExistsSemNove.jid
                waExists = waExistsSemNove
            }
        } else if (!waExists?.exists && cleanNumber.startsWith('55') && cleanNumber.length === 12) {
            // Se tem 12 dígitos (ex: 55 33 8896-2572), tenta adicionar o 9 após o DDD
            const comNove = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4)
            const [waExistsComNove] = await currentSock.onWhatsApp(`${comNove}@s.whatsapp.net`)
            if (waExistsComNove?.exists) {
                jid = waExistsComNove.jid
                waExists = waExistsComNove
            }
        }

        if (waExists?.exists) {
            jid = waExists.jid
            logger.info({ jid }, 'JID oficial validado no WhatsApp com sucesso')
        } else {
            logger.warn({ jid }, 'Aviso: Número não encontrado na verificação onWhatsApp, tentando envio direto por fallback...')
        }

        // Dispara a mensagem para o JID oficial
        const sentMsg = await currentSock.sendMessage(jid, { text: message })
        logger.info({ jid }, 'Lembrete disparado com sucesso via API')

        return res.status(200).json({ success: true, messageId: sentMsg?.key?.id })
    } catch (error: any) {
        logger.error(error, 'Erro ao disparar lembrete via API')
        return res.status(500).json({ error: 'Falha ao enviar mensagem', details: error.message })
    }
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
    logger.info(`Servidor da API Express rodando na porta ${PORT}`)
})
