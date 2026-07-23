# Controle Run

Aplicativo desktop local-first para adicionar pastas de projetos, administrar cada frontend e backend com PM2 e configurar GitHub Actions Runners no Windows.

## Stack

- Electron para acesso às pastas e execução local no Windows;
- React, TypeScript e Vite para a interface;
- PM2 programático para processos e métricas;
- electron-builder para o instalador Windows.

## GitHub Actions Runners

A aba **Runners GitHub** instala e administra self-hosted runners separadamente dos processos PM2. O fluxo:

- consulta o pacote Windows x64 mais recente publicado pelo GitHub;
- mantém um cache local do ZIP e valida o SHA-256 oficial antes de extrair;
- registra um runner de organização ou de repositório;
- instala o runner como serviço do Windows, sem manter uma janela de terminal aberta;
- mostra serviço, conexão inferida pelos logs, versão, labels e projeto associado;
- permite iniciar, parar, reiniciar, abrir os logs e remover o runner de forma segura.

A instalação padrão usa `C:\actions-runners\<nome>`. Como a criação do serviço exige privilégios administrativos, o Windows exibe o UAC somente nas ações que alteram o serviço.

O token de registro, o token de remoção e a senha opcional da conta do serviço nunca são gravados no `settings.json`. Durante a elevação, a solicitação temporária é protegida pelo DPAPI do Windows e apagada ao final.

Para atender vários repositórios da mesma organização, use uma URL como `https://github.com/minha-organizacao`. Para isolamento por repositório, use `https://github.com/minha-organizacao/meu-repositorio`.

O serviço pode executar como:

- `NT AUTHORITY\NETWORK SERVICE`, recomendado para builds isolados;
- uma conta Windows específica, necessária quando o workflow deve acessar pastas do usuário ou o mesmo ambiente PM2.

### Deploy automático por repositório

Para runners com escopo de repositório, conta Windows específica e projeto associado, o botão **Preparar deploy** configura o fluxo completo:

- valida que o `origin` do clone local corresponde ao repositório do runner;
- cria `.github/workflows/controle-run.yml` com um modelo único para todos os projetos;
- instala um executor local dentro da pasta do runner e reinicia o serviço para carregar sua localização;
- registra a pasta publicada e os processos PM2 daquele projeto, sem gravar senhas ou tokens;
- mostra no card o estado da configuração e o resultado do último deploy.

O workflow usa o checkout temporário autenticado pelo próprio GitHub e transfere o commit para o clone publicado por Git local. Assim, o clone do servidor não precisa armazenar outro token. Arquivos não controlados pelo Git, como `.env` e `node_modules`, são preservados. O deploy é interrompido se houver alterações locais em arquivos controlados, e uma falha ao reiniciar os serviços tenta restaurar o commit anterior.

Depois de preparar, faça commit e push do arquivo `.github/workflows/controle-run.yml` criado no clone. Os pushes seguintes em `main` ou `master` serão encaminhados ao runner. O botão **Copiar workflow padrão** permite levar o mesmo modelo para repositórios criados em outra máquina.

O runner usa `_work` como workspace temporário; o código publicado continua no caminho original cadastrado no Controle Run.

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
