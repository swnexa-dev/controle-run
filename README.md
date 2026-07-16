# Controle Run

Aplicativo desktop offline para adicionar pastas de projetos e administrar cada frontend e backend local com PM2.

## Stack

- Electron para acesso às pastas e execução local no Windows;
- React, TypeScript e Vite para a interface;
- PM2 programático para processos e métricas;
- electron-builder para o instalador Windows.

## Detecção

O botão **Adicionar projeto** seleciona a pasta de um projeto individual. Dentro dela, o aplicativo procura `frontend` e `backend` e cria um serviço PM2 independente para cada um. O botão pode ser usado novamente para cadastrar projetos localizados em outras pastas. Em cada serviço, procura os scripts `start`, `serve` ou `dev` do `package.json`, depois o campo `main` e arquivos comuns como `index.js`, `server.js` e `dist/index.js`.

```text
projeto-a/
    frontend/
      package.json
    backend/
      package.json
projeto-b/
    frontend/
    backend/
```

Projetos simples que tenham o `package.json` diretamente na pasta continuam compatíveis.

Se nada for encontrado, use **Configurar** para escolher um script NPM ou informar o arquivo de entrada. A configuração fica no perfil local do usuário e não modifica os projetos.

## Desenvolvimento

```bash
npm install
npm run dev
```

## Validação e instalador

```bash
npm test
npm run build
npm run package:win
```

O instalador é criado na pasta `release`. Pausar corresponde a parar o processo no PM2 sem remover sua definição; iniciar novamente funciona como continuar.
