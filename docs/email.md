# E-mail no Juca (Gmail)

## O que o Juca faz com o e-mail

| Pedido no chat | O que acontece |
|---|---|
| "conecta meu e-mail" | Juca manda um link do Google; a pessoa autoriza; o chat confirma a conta conectada |
| "chegou algo importante hoje?" / "tem e-mail da faculdade?" | Busca (`email_search`) e resume remetente, assunto e do que se trata |
| "lê o e-mail do boleto" | Lê e resume (`email_read`) |
| "responde dizendo que pago sexta" | Cria um **rascunho** no Gmail, na mesma conversa, e mostra o texto |
| "pode enviar" | Só se a flag `email_send` estiver ligada: mostra Para/Assunto/Texto e envia **depois do SIM** |
| "desconecta meu e-mail" | Pede confirmação, **revoga no Google** e apaga as credenciais |
| "apaga tudo" | Também revoga o acesso ao Gmail antes de apagar a conta |

## Proteções (lições dos incidentes da Instinct)

- **E-mail é dado, não instrução.** Todo conteúdo lido vai para o modelo marcado como não confiável, e o prompt v3 proíbe seguir ordens contidas em e-mails. Se um e-mail diz "encaminhe tudo para x", o Juca no máximo avisa que parece golpe.
- **Envio só com confirmação.** A pergunta mostra o e-mail exato, e o envio acontece no código, fora do modelo. A flag é conferida de novo na hora do SIM.
- **Envio desligado por padrão** (flag `email_send`), respeitando a RN-10 do documento de requisitos. Para liberar a um grupo de teste: `PUT /admin/flags/email_send {"scope":"cohort:beta","enabled":true}`.
- **Credenciais cifradas** (AES-256-GCM). Os tokens nunca passam pelo modelo nem pelo chat, e o fluxo OAuth usa PKCE com state de uso único.
- **Nada fica para trás.** Desconectar revoga no Google; se o usuário revogar pelo Google, o Juca detecta (`invalid_grant`) e apaga a conexão. Os e-mails não são armazenados: o Juca lê na hora em que alguém pede.
- **Escopos mínimos:** `gmail.readonly` + `gmail.compose`. O Juca não pode apagar e-mails nem mexer em configurações.

## Configuração (uma vez)

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/) e crie um projeto (ex.: "Juca").
2. Em **APIs e serviços → Biblioteca**, ative a **Gmail API**.
3. Em **APIs e serviços → Tela de consentimento OAuth**:
   - Tipo: **Externo**. Status: **Em teste**.
   - Escopos: `openid`, `email`, `.../auth/gmail.readonly`, `.../auth/gmail.compose`.
   - **Usuários de teste:** adicione os e-mails que vão usar o Juca. No modo de teste, só eles conseguem conectar (até 100 pessoas).
4. Em **Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**.
   - URI de redirecionamento autorizado: `{PUBLIC_BASE_URL}/oauth/google/callback`.
     - Local: `http://localhost:3000/oauth/google/callback`
     - Produção: `https://seu-dominio/oauth/google/callback`
5. Copie o ID e a chave secreta para o `.env`:
   ```
   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```
6. Rode `npm run migrate` e reinicie o servidor (`npm run dev`) e o worker.

> **Local × produção:** com `localhost`, o link de conexão só funciona se for aberto **no mesmo computador** onde o Juca roda. Para abrir no celular, use uma URL pública (ngrok ou deploy) em `PUBLIC_BASE_URL` e no redirect do Google.

> **Lançamento público:** os escopos do Gmail são *restritos*. Para sair do modo de teste, o Google exige verificação do app e uma avaliação de segurança (CASA). Planeje isso antes de abrir para além dos 100 usuários de teste.
