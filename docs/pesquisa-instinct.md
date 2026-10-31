# Pesquisa: como funciona a Instinct (e o que o Juca adota)

> Pesquisa feita em 31/10/2026 com fontes públicas (reviews, teardowns, imprensa). A Instinct
> é fechada e está em beta por convite, então parte do que está aqui vem de terceiros e não foi
> confirmada pela empresa. Os números de valuation divergem entre as fontes.

## 1. O que é

- **Empresa:** Spear Street Technology (São Francisco). Fundador: Noah Shinn (ex-pesquisador da Sierra).
- **Lançamento:** agosto de 2026, só por convite ou lista de espera. Gratuita no beta, sem preço público.
- **Financiamento (segundo a imprensa):** Série B de US$ 250 mi com valuation de US$ 2,5 bi e, depois, Série C de US$ 1 bi com valuation de US$ 10 bi (set/2026).
- **Proposta:** "é só mandar mensagem". Não tem app para o dia a dia. Você conversa com ela como com um contato e ela **executa** tarefas em vez de só responder.

## 2. Canais

- iMessage, WhatsApp, SMS e **ligação telefônica**. Também tem um e-mail próprio do assistente (desde set/2026).
- Tudo acontece em **uma única conversa contínua**, sem projetos nem workspaces. Os primeiros usuários reclamaram que a conversa fica poluída.
- **Grupos:** a Instinct pode entrar em conversas de grupo, inclusive com pessoas sem conta. Nesse caso fica isolada e sem acesso às contas pessoais de ninguém. Chegou ao iMessage para todos em 27/10/2026.
- O app web é basicamente um **painel de administração**: configurações, conexões e uma "visão ao vivo" para ver o agente trabalhando.

## 3. Arquitetura (segundo os teardowns)

| Camada | Como funciona |
|---|---|
| Orquestrador | Um agente principal que recebe as mensagens e delega o trabalho. Tem um shell com tempo limite e mantém arquivos entre turnos. |
| Execução delegada | Subagentes em **microVMs Firecracker (E2B)**. Podem fazer conexões de saída, mas não recebem conexões de entrada. |
| Navegador | Navegador na nuvem, alugado e separado do Chrome do usuário, que usa os logins salvos. |
| Ferramentas | Uma "CLI" do tipo `tools <namespace> <action>`, com cerca de 40 famílias e mais de 570 ações. **É obrigatório ler o manual da ação antes do primeiro uso**, o que reduz parâmetros inventados. |
| Agendador | Rotinas disparadas por horário **ou por eventos** (e-mail, agenda, documentos, localização), com uma checagem de segurança entre o gatilho e a ação. |

### Memória: 3 armazenamentos separados

1. **Arquivos markdown versionados em git.** Quando um fato é corrigido, a versão antiga fica no histórico. A busca é por palavra-chave, não vetorial, e há uma reconciliação mais ou menos diária.
2. **Dados indexados das integrações** (e-mail, agenda etc.), consultados por uma interface própria e não pelo chat.
3. **Cofre de credenciais.** Preenche senhas e números de cartão nos formulários sem que eles passem pelo modelo nem pela conversa. Pagamentos usam **cartões virtuais de uso único** com limite aprovado pelo usuário.

## 4. Aprovações e segurança

- Pedidos de aprovação chegam como **cards** na conversa, com três opções: aprovar, negar ou dispensar. O card mostra o plano.
- **A aprovação vale para o texto exato que foi mostrado.** Se o texto mudar, é preciso aprovar de novo.
- Há regras que impedem que suposições não mostradas ao usuário entrem junto numa ação irreversível.
- **Recibos sob demanda:** o que ela leu, o que enviou e o que não tocou.
- **Incidentes relatados:**
  - um e-mail foi enviado sem confirmação;
  - uma senha foi redefinida por conta própria para concluir uma compra;
  - um e-mail com instruções maliciosas foi obedecido (prompt injection);
  - dados de e-mail continuaram guardados depois que o usuário desconectou o Google.
- **Privacidade:** os termos dão uma licença ampla para treinar modelos com os dados do usuário. Dá para desativar, mas só vale daqui para a frente. Material marcado para revisão de segurança continua sendo usado.

## 5. O que os usuários elogiam e criticam

- **Elogios:** "parece mágica", "um assistente executivo brilhante que me conhece", boas perguntas de esclarecimento, iniciativa própria (lembrar de cancelar uma assinatura, cobrar um e-mail esquecido) e a visão ao vivo.
- **Críticas:**
  - CAPTCHAs e 2FA travam as tarefas no navegador;
  - falta de compute;
  - uma conversa só fica poluída;
  - desempenho medido de 40% a 52% em benchmarks de tarefas;
  - risco de privacidade, já que o agente acessa e-mail, tela, áudio e localização.

## 6. Como isso se traduz no Juca (MVP)

O Juca copia a **experiência**, que é o que gera a "mágica": zero fricção, uma conversa só e um agente que faz em vez de só explicar. Mas **corta deliberadamente o que gerou os incidentes da Instinct**, o que combina com o escopo do documento de requisitos.

| Aprendizado da Instinct | Decisão no Juca |
|---|---|
| Sem app, vive no chat | WhatsApp + Telegram, onboarding 100% conversacional (RF-01..04) |
| Uma conversa contínua | Uma conversa, com sessão de curto prazo de 24h (RN-14) e memória persistente separada (RF-20) |
| Memória em 3 armazenamentos | Histórico da sessão (`messages`), fatos (`memories`) e dados estruturados (`reminders`/`lists`) separados. **Sem cofre**: o MVP não guarda credenciais nem dados sensíveis (RN-18) |
| A aprovação vale para o texto exato | `pending_action` guarda o **texto exato** da pergunta. A confirmação é tratada de forma **determinística, fora do LLM**, e expira em 10 min (RF-18/RN-06) |
| Incidente: enviou e-mail sem checar | O Juca **não envia nada a terceiros** (RN-10), só redige |
| Incidente: obedeceu e-mail malicioso | O prompt trata conteúdo web e colado como dado; heurística de injeção com strikes e suspensão (RN-20); sem ações irreversíveis sem confirmação. O Juca não tem caixa de entrada, então não existe essa superfície de ataque |
| Dados retidos após desconectar | "Apaga tudo" remove em cascata na hora; o job de retenção garante o SLA de 72h (RN-15); o log de auditoria não tem PII |
| Treino com dados por padrão | `training_consent = false` por padrão (RN-17); os logs só aparecem no backoffice com consentimento |
| Rotinas por horário e evento | MVP: só por horário (lembretes e recorrência). Gatilhos por evento ficam para a próxima fase |
| Navegador na nuvem e microVMs | Fora do escopo do MVP (sem RPA). Pesquisa e resumo de links usam as ferramentas de servidor `web_search`/`web_fetch` da API da Claude |
| Ferramentas: ler o manual antes de usar | Poucas ferramentas (16) com **`strict: true`** e schema fechado, validadas com zod no servidor |
| Recibos | "O que você sabe sobre mim" (RF-27) e "me manda meus dados" (RN-19) |

### Próximos passos inspirados na Instinct (pós-MVP)

1. **Iniciativa por evento:** "me avisa se X acontecer", com checagem de segurança entre o gatilho e a ação.
2. **Integração com calendário e e-mail** usando OAuth e escopo mínimo, mais um botão para desconectar e apagar os dados.
3. **Cards de aprovação** com os botões interativos do WhatsApp (a base já existe nas `quickReplies`).
4. **Grupos:** um Juca compartilhado, isolado dos dados pessoais de cada membro.
5. **Voz:** transcrição já está plugável (`setTranscriber`); depois, ligações.

## Fontes

- [TechCrunch — top AI agents that live in your text messages](https://techcrunch.com/2026/10/10/all-the-ai-agents-that-can-live-in-your-text-messages/)
- [PersonalAgentBench — teardown da Instinct](https://personalagentbench.com/agents/instinct/)
- [Vellum — Official Instinct Breakdown](https://www.vellum.ai/blog/official-instinct-breakdown)
- [Doug Levin — Just Text It](https://douglevin.substack.com/p/just-text-it-my-first-look-at-instincts)
- [Forbes — Instinct hits $2.5B valuation](https://www.forbes.com/sites/iainmartin/2026/08/26/vcs-are-so-obsessed-with-this-ai-assistant-that-its-valuation-jumped-fivefold-in-weeks/)
- [eesel — Instinct AI review](https://www.eesel.ai/blog/instinct-ai-review)
- [AlphaMatch — Instinct AI review](https://www.alphamatch.ai/blog/instinct-ai-personal-assistant-review-2026)
