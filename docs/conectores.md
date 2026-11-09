# Conectores: como ativar

Cada conector liga sozinho quando as chaves estão no `.env`. Depois, rode `npm run migrate` e reinicie o servidor e o worker. No chat, peça por exemplo "conecta meu gmail".

`PUBLIC_BASE_URL` precisa ser acessível de onde o link será aberto. Com `localhost`, só funciona no próprio computador.

## Gmail + Google Calendar

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto e ative **Gmail API** e **Google Calendar API**.
2. Tela de consentimento: **Externo / Em teste**, com seus e-mails como **usuários de teste** (até 100).
3. Escopos: `openid`, `email`, `gmail.readonly`, `gmail.compose`, `calendar.events`.
4. Crie um **ID do cliente OAuth** (Aplicativo da Web), com redirect `{PUBLIC_BASE_URL}/oauth/google/callback`.
5. Preencha `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.

Quem conectou o Gmail antes desta versão precisa desconectar e conectar de novo para liberar o calendário.

## Outlook / Microsoft 365

1. No [Entra](https://entra.microsoft.com/) → Registros de aplicativo → Novo registro.
2. Tipos de conta: **qualquer diretório e contas pessoais**. Redirect (Web): `{PUBLIC_BASE_URL}/oauth/microsoft/callback`.
3. Permissões delegadas do Microsoft Graph: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`.
4. Crie um segredo do cliente e preencha `MICROSOFT_CLIENT_ID` e `MICROSOFT_CLIENT_SECRET`.

A Microsoft não documenta revogação de um token específico. Ao desconectar, o Juca apaga as credenciais; para retirar o consentimento também na Microsoft, remova o app em account.live.com/consent/Manage.

## Bancos (Open Finance via Pluggy)

1. Crie uma conta em [pluggy.ai](https://pluggy.ai) e pegue `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET`.
2. Para testar sem banco real, use `PLUGGY_INCLUDE_SANDBOX=true`.

O login acontece no widget da Pluggy, e o Juca nunca vê a senha. É somente leitura: não existe ferramenta de Pix ou pagamento. A Pluggy é um serviço pago em produção; confira os planos.

Limitação conhecida: alguns bancos concluem a autorização depois de fechar o widget, e a Pluggy só avisa por webhook. Esse caso ainda não é tratado; a pessoa precisa conectar de novo.

## Cotações

Funcionam sem configuração: B3 (brapi.dev), câmbio (AwesomeAPI) e cripto (CoinGecko). Sem `BRAPI_TOKEN`, só alguns ativos da B3 respondem; crie um token gratuito em [brapi.dev](https://brapi.dev). Os dados da brapi podem não ser em tempo real.

## Pesquisa web geral

Defina `BRAVE_SEARCH_API_KEY` ([brave.com/search/api](https://brave.com/search/api/)).

## O que o Juca faz com cada conta

As permissões, as confirmações e as defesas estão em [`modelagem-grokbot.md`](modelagem-grokbot.md).
