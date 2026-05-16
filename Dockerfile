FROM node:20-slim

# Instala ferramentas de compilação nativa (python3, make, g++, git)
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

# Habilita o corepack para suporte ao Yarn v4
RUN corepack enable

# Define o diretório de trabalho dentro do container
WORKDIR /app

# CRÍTICO PARA O YARN V4 (BERRY): Copia todo o projeto ANTES do yarn install.
# Como o Baileys é referenciado como workspace (baileys@workspace:.), se rodarmos o yarn install
# antes de copiar os arquivos do projeto (COPY . .), o Yarn v4 perde a referência do workspace
# no lockfile e gera o erro: "Internal Error: baileys@workspace:.: This package doesn't seem to be present in your lockfile".
COPY . .

# Força o ambiente como development para garantir a instalação do TypeScript e ferramentas de build
ENV NODE_ENV=development

# Instala todas as dependências com o projeto completo já presente no diretório
RUN yarn install --no-immutable

# Executa o build do TypeScript com o workspace perfeitamente linkado
RUN yarn build

# Define o ambiente final como produção para a execução otimizada do bot
ENV NODE_ENV=production

# Comando de inicialização do bot
CMD ["yarn", "example"]
