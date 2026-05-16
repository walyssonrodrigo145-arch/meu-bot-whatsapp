FROM node:20-slim

# Habilita o corepack para suporte ao Yarn v4 (utilizado no projeto)
RUN corepack enable

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de manifesto e trava de versão
COPY package.json yarn.lock .yarnrc.yml engine-requirements.js ./

# Instala todas as dependências (incluindo tsx necessário para rodar o Example)
RUN yarn install

# Copia todo o código-fonte do projeto
COPY . .

# Executa o build do TypeScript
RUN yarn build

# Define o ambiente como produção
ENV NODE_ENV=production

# Comando de inicialização do bot
CMD ["yarn", "example"]
