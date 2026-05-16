FROM node:20-slim

# Instala ferramentas de compilação nativa (python3, make, g++, git)
# Essencial caso pacotes nativos (como libsignal ou whatsapp-rust-bridge) precisem ser compilados
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

# Habilita o corepack para suporte ao Yarn v4 (utilizado no projeto)
RUN corepack enable

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de manifesto e trava de versão
COPY package.json yarn.lock .yarnrc.yml engine-requirements.js ./

# Instala todas as dependências com --no-immutable
# CRÍTICO: Como instalamos o qrcode-terminal via npm, o yarn.lock estava desatualizado em relação ao package.json.
# O parâmetro --no-immutable permite que o Yarn atualize o lockfile no container sem quebrar o build!
RUN yarn install --no-immutable

# Copia todo o código-fonte do projeto
COPY . .

# Executa o build do TypeScript
RUN yarn build

# Define o ambiente como produção
ENV NODE_ENV=production

# Comando de inicialização do bot
CMD ["yarn", "example"]
