# Plano de Arquitetura: Bot WhatsApp Multi-Sessão (SaaS Multi-Tenant)

Este documento especifica a arquitetura e o plano de implementação para transformar o microsserviço atual do robô Baileys em um gerenciador centralizado de múltiplas sessões de WhatsApp. Isso permitirá que diversos professores conectem seus próprios números de WhatsApp diretamente pelo painel do site e realizem disparos de lembretes de forma totalmente independente.

---

## 1. Visão Geral do Sistema

Atualmente, o robô opera em modo **mono-sessão** (um único JID salvo na pasta raiz `baileys_auth_info`). Na nova arquitetura **multi-sessão**, o servidor Express atuará como um orquestrador. Cada professor terá uma identificação única (`sessionId`, ex: `prof_joao_123`) associada a uma subpasta isolada dentro do volume persistente do Fly.io.

```
/app/baileys_auth_info/ (Volume Persistente)
 ├── prof_joao_123/
 │    ├── creds.json
 │    └── session.json
 ├── prof_maria_456/
 │    ├── creds.json
 │    └── session.json
 └── prof_pedro_789/
      ├── creds.json
      └── session.json
```

---

## 2. Estrutura em Memória (Gerenciamento de Sockets)

No código TypeScript (`Example/example.ts`), manteremos um `Map` global para armazenar e gerenciar os sockets ativos de cada professor em tempo real.

```typescript
interface SessionData {
    sock: any;
    status: 'PAIRING' | 'CONNECTED' | 'DISCONNECTED';
    qr?: string;
    pairingCode?: string;
}

const sessions = new Map<string, SessionData>();
```

---

## 3. Especificação Completa da Nova API Express

O servidor web na porta 8080 disponibilizará 4 endpoints principais para o site consumir:

### 3.1. Iniciar Pareamento (`POST /sessions/start`)
Inicia uma nova instância do Baileys para o professor, solicita o Código de Pareamento ao WhatsApp e o devolve para o site exibir na tela.

* **Requisição (JSON)**:
  ```json
  {
    "apiKey": "minha_chave_secreta_123",
    "sessionId": "prof_joao_123",
    "phoneNumber": "5533999958830"
  }
  ```
* **Resposta de Sucesso (200 OK)**:
  ```json
  {
    "success": true,
    "sessionId": "prof_joao_123",
    "status": "PAIRING",
    "pairingCode": "A1B2-C3D4",
    "message": "Código gerado com sucesso. Digite no celular em até 60 segundos."
  }
  ```

### 3.2. Consultar Status da Sessão (`POST /sessions/status`)
Permite ao site verificar em tempo real se o professor já digitou o código e está conectado.

* **Requisição (JSON)**:
  ```json
  {
    "apiKey": "minha_chave_secreta_123",
    "sessionId": "prof_joao_123"
  }
  ```
* **Resposta (200 OK)**:
  ```json
  {
    "sessionId": "prof_joao_123",
    "status": "CONNECTED",
    "phone": "5533999958830",
    "message": "WhatsApp conectado e pronto para disparos."
  }
  ```

### 3.3. Disparar Lembrete (`POST /send-message`) [Atualizado]
Realiza o disparo da mensagem utilizando o socket específico do professor.

* **Requisição (JSON)**:
  ```json
  {
    "apiKey": "minha_chave_secreta_123",
    "sessionId": "prof_joao_123",
    "number": "5511999999999",
    "message": "Olá João! Lembrete da sua mensalidade de música."
  }
  ```
* **Resposta de Sucesso (200 OK)**:
  ```json
  {
    "success": true,
    "sessionId": "prof_joao_123",
    "messageId": "3EB098B52CF31974D44AA9"
  }
  ```

### 3.4. Desconectar / Excluir Sessão (`POST /sessions/logout`)
Desconecta o WhatsApp do professor e apaga a subpasta dele do volume persistente.

* **Requisição (JSON)**:
  ```json
  {
    "apiKey": "minha_chave_secreta_123",
    "sessionId": "prof_joao_123"
  }
  ```
* **Resposta (200 OK)**:
  ```json
  {
    "success": true,
    "message": "Sessão encerrada e arquivos removidos com sucesso."
  }
  ```

---

## 4. Ciclo de Vida e Auto-Recuperação (Boot Automático)

Para garantir que os professores não precisem logar novamente quando o servidor do Fly.io reiniciar, implementaremos uma rotina de inicialização autônoma:

1. Ao ligar, o servidor lê o diretório raiz `/app/baileys_auth_info`.
2. Para cada subpasta encontrada (ex: `prof_joao_123`, `prof_maria_456`), o sistema inicializa o `makeWASocket` em segundo plano e adiciona a instância ao `Map` global com status `CONNECTED`.
3. Se alguma sessão apresentar erro `401 Unauthorized` (chaves revogadas pelo celular), o robô deleta apenas a subpasta daquele professor específico, mantendo os demais professores logados e intactos.

---

## 5. Guia de Implementação no Frontend do Site

No painel do site (ex: página de Perfil do Professor ou Configurações de WhatsApp), o fluxo de telas será:

### Etapa 1: Tela de Conexão
* O professor acessa a aba "Meu WhatsApp".
* O site exibe um campo de input para o DDD + Número e um botão *"Gerar Código de Conexão"*.

### Etapa 2: Exibição do Código
* Ao clicar no botão, o site faz o `fetch` para `/sessions/start`.
* O site exibe o código retornado (`A1B2-C3D4`) em destaque na tela com as instruções: *"Abra o WhatsApp no celular > Aparelhos Conectados > Conectar com número de telefone e digite o código abaixo"*.

### Etapa 3: Polling de Confirmação
* Enquanto o código está na tela, o site faz um `fetch` a cada 3 segundos para `/sessions/status`.
* Assim que a resposta mudar para `status: "CONNECTED"`, o site exibe um aviso de sucesso animado: *"WhatsApp Conectado com Sucesso!"* e oculta a tela de pareamento.

---

## 6. Próximos Passos para Execução

Quando desejar iniciar a implementação deste plano, bastará solicitar:
1. A refatoração do arquivo `Example/example.ts` com a lógica do `Map` e as novas rotas Express.
2. O teste de criação de sessão e disparo isolado.
3. A criação das funções de `fetch` correspondentes no repositório do site.
