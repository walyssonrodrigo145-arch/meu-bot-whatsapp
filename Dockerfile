FROM node:20-slim

# Instala ferramentas de compilação nativa (python3, make, g++, git)
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

# Habilita o corepack para suporte ao Yarn v4
RUN corepack enable

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de manifesto e trava de versão
COPY package.json yarn.lock .yarnrc.yml engine-requirements.js ./

# CRÍTICO: Força o ambiente como development durante a instalação
# O builder do Fly.io injeta NODE_ENV=production por padrão no ambiente de build.
# Isso faz o Yarn ignorar as devDependencies (como typescript, tsc-esm-fix e tsx).
# Sem elas, o comando 'yarn build' falha com código de saída 1 por não encontrar o tsc!
ENV NODE_ENV=development

# Instala TODAS as dependências (incluindo devDependencies essenciais para o build)
RUN yarn install --no-immutable

# Copia todo o código-fonte do projeto
COPY . .

# Executa o build do TypeScript com o tsc e tsc-esm-fix instalados
RUN yarn build

# Define o ambiente final como produção para a execução otimizada do bot
ENV NODE_ENV=production

# Comando de inicialização do bot
CMD ["yarn", "example"]
