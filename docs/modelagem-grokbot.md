# Modelagem: do Grok Bot ao Juca

> Baseada em fontes públicas de novembro de 2026 (principalmente o guia de Flavio Copes; o Grok Bot está em beta e as fontes divergem em alguns pontos). "Grok Bot" aqui é o agente da xAI em x.ai/bot.

## 1. Como o Grok Bot funciona

```
Canais (app, X, Slack, ligação)
        ▼
Bot = instruções + memória + skills + rotinas
        ▼
Auto Review ── consequente? ──► cartão de aprovação
        ▼
Plugins (ações nomeadas) ── sem plugin? ──► navegador num computador na nuvem
        ▼
Vault: o modelo usa logins e cartões sem ver os segredos
```

- **Plugins primeiro:** ações nomeadas são mais confiáveis e baratas que operar o navegador.
- **Rotinas:** rodam por horário ou evento, sem o usuário por perto. O que elas enviam fica como rascunho.
- **Autorização:** só as mensagens do próprio usuário contam como pedido. E-mail e web são informação.
- **Finanças:** leitura de banco, cartão e corretora via agregador (Plaid). Cada compra exige aprovação.

## 2. O que o Juca adota

| Conceito do Grok Bot | No Juca | Estado |
|---|---|---|
| Plugins com ações nomeadas | `connector-tools.ts`: e-mail, calendário, bancos, cotações | Pronto |
| Só carregar o que importa | Ferramentas só entram no prompt quando a conta está conectada | Pronto |
| Conta por serviço, várias contas | Gmail + Outlook; se houver duas, o Juca pergunta qual usar | Pronto |
| Cartão de aprovação | `pending_action` + botões Sim/Não, tratados no código, fora do modelo | Pronto |
| Só o usuário autoriza | Prompt v4 + conteúdo externo marcado como não confiável | Pronto |
| Vault | OAuth e widget Pluggy: o Juca nunca recebe senha; tokens cifrados | Pronto |
| Rotinas por horário | `create_routine`: o agente executa e manda o resultado | Pronto |
| Rotina não envia sozinha | `ROUTINE_BLOCKED`: envio, exclusão e convites ficam bloqueados | Pronto |
| Leitura financeira via agregador | Pluggy (Open Finance do Brasil, equivalente ao Plaid) | Pronto |
| Memória persistente | `memories` + histórico da sessão | Já existia |
| Rotinas por evento (e-mail novo etc.) | Falta webhook de cada provedor | Próximo passo |
| Skills reutilizáveis | `save_skill`, chamadas com `/nome` | Pronto |
| Papel e preferências do Bot | `set_my_instructions`, injetadas em todo turno | Pronto |
| Rotinas condicionais | Só enviam se a condição acontecer (`SEM_NOVIDADES`) | Pronto |
| Acesso por convite (Instinct) | Código de uso único, link do Telegram, lista de espera, 3 convites por pessoa | Pronto |
| Pesquisa web geral | Pronta, depende de `BRAVE_SEARCH_API_KEY` | Falta a chave |
| Navegador e computador na nuvem | Falta. Pede sandbox isolado e infraestrutura própria | Fase futura |
| Ligações telefônicas | Falta | Fase futura |
| Compras com cartão de uso único | Fora do escopo de propósito | Decisão |

## 3. Fluxo ponta a ponta

```
Mensagem (WhatsApp/Telegram)
  → webhook valida assinatura → fila → worker com lock por usuário
  → idempotência, rate limit, ack ("digitando…")
  → onboarding? comandos? confirmação pendente? (tudo no código, sem modelo)
  → agente: prompt v4 + contexto (data, próximos dias, contas conectadas)
      → modelo escolhe ferramentas (NVIDIA NIM; Claude opcional)
      → leitura executa direto
      → ação consequente gera pending_action
  → sistema envia a pergunta exata → "sim" → código executa
```

Mensagens proativas (lembretes e rotinas) saem pelo canal usado mais recentemente. No WhatsApp, fora da janela de 24h, vão por template aprovado.

## 4. Matriz de permissões

| Ação | Execução |
|---|---|
| Buscar e ler e-mail, agenda, saldo, extrato, cotação | Direta |
| Criar rascunho; criar evento sem convidados | Direta |
| Enviar e-mail | Mostra o rascunho **como está no provedor** e pede SIM. Se o rascunho mudar depois da pergunta, não envia |
| Evento com convidados; apagar evento | SIM |
| Desconectar conta; apagar lista; apagar tudo | SIM |
| Pix, pagamento, transferência | **Não existe ferramenta** |

## 5. Defesas contra instruções escondidas

O risco central é um agente que lê conteúdo de terceiros, acessa dados privados e consegue enviar coisas para fora. Por isso:

1. E-mail, agenda, extrato e web chegam ao modelo marcados como não confiáveis.
2. Todo envio passa por SIM sobre o texto real, verificado no código.
3. `web_fetch` só abre URLs escritas pela própria pessoa ou achadas na busca, para uma ordem escondida não vazar dados numa URL.
4. Rotinas não executam ações consequentes.
5. Respostas com dados bancários não vão para o histórico.
6. Rotina, skill, preferência e convite não podem ser criados na mesma mensagem que leu conteúdo externo: uma ordem escondida não vira comportamento permanente.

## Convites

- Sem código válido, a pessoa fica na lista de espera e não chega ao cadastro.
- Códigos de administrador: `npm run invite -- 5` ou `POST /admin/invites {"count":5}`.
- Cada usuário tem 3 convites; pede no chat ("me dá um convite").
- Lista de espera: `GET /admin/waitlist` e `POST /admin/users/:id/approve`.
- `INVITE_ONLY=false` abre o cadastro.

## 6. Mudanças nos requisitos do MVP

Esta fase substitui, por decisão do produto:

- **RN-10:** o Juca agora envia e-mail em nome da pessoa, sempre com confirmação.
- **RN-05 e "fora de escopo":** e-mail, calendário e consulta bancária entram no escopo.
- **RN-18:** dados bancários são lidos sob demanda. Continuam sem ser armazenados, mas passam pelo modelo de IA.
- **RN-09 continua valendo:** nenhuma transação financeira.

## 7. Antes de abrir para usuários reais

- **Dados financeiros e LGPD:** extratos e e-mails são enviados ao provedor do modelo. Confirme as condições de uso e retenção da NVIDIA para dados pessoais (a chave atual é provisória) e atualize os termos de uso, que hoje dizem que o Juca não lida com dados financeiros.
- **Google:** Gmail é escopo restrito. Acima de 100 usuários de teste, exige verificação e auditoria.
- **Latência:** com o modelo atual, de 2 a 12 s nos testes; a meta do documento é 3 s.

## Fontes

- [Flavio Copes: A deep dive into Grok Bot](https://flaviocopes.com/grok-bot/)
- [AI Builder Club: How to Build Your Own Grok Bot](https://www.aibuilderclub.com/blog/how-to-build-your-own-grok-bot)
