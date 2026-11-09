# Panorama: o Juca no dia a dia

Três níveis de ação:

- **Faz:** executa de ponta a ponta.
- **Deixa pronto:** prepara um link; a pessoa confirma e paga no app.
- **Não dá hoje:** falta API, parceria ou decisão de produto.

| Área | Pedido | Hoje | Caminho para fazer sozinho |
|---|---|---|---|
| Transporte | Uber | Deixa pronto (abre com destino) | Aprovação da Uber para a API de corridas |
| Transporte | 99 | Deixa pronto (abre o app, destino digitado) | Parceria; sem API pública encontrada |
| Transporte | Rota no Waze/Maps | Deixa pronto | Já resolve |
| Transporte | Passagem aérea | Pesquisa preços e monitora; compra é da pessoa | Duffel ou agência parceira para emitir |
| Comida | iFood, Rappi | Deixa pronto (abre o app) | Parceria; APIs públicas são só para restaurantes |
| Compras | Mercado Livre, Amazon | Deixa pronto (abre a busca) | Programas de afiliados/APIs de cada loja |
| Hospedagem | Booking | Deixa pronto | API de parceiro |
| Mensagens | WhatsApp a um contato | Deixa pronto (mensagem escrita) | Já resolve |
| E-mail | Gmail | Faz | Outlook depende das credenciais |
| Agenda | Google Calendar | Faz | - |
| Finanças | Saldo e extrato | Faz (leitura) | Pix e pagamentos: decisão de produto e regulatória |
| Finanças | Boleto, contas | Não dá | Ler foto/PDF do boleto e lembrar do vencimento |
| Mercado | Ações, câmbio, cripto | Faz | - |
| Informação | Clima, CEP, CNPJ, feriados, resumo de link | Faz | - |
| Informação | Notícias, pesquisa geral | Não dá | `BRAVE_SEARCH_API_KEY` |
| Rotina | Lembretes, listas, rotinas, skills | Faz | Gatilhos por evento |
| Arquivos | Foto, PDF, nota fiscal | Não dá | Modelo de visão |
| Casa | Luzes, Alexa, Google Home | Não dá | Conectores de automação |
| Saúde | Consultas, farmácia | Não dá | Parcerias; dados sensíveis (RN-18) |

## Por que o Juca não chama o Uber nem faz o pedido no iFood

Não encontramos API aberta para consumidor no iFood, Rappi e 99: as documentações são para restaurantes e parceiros. A API de corridas da Uber exige aprovação.

Bots de navegador usando o login da pessoa funcionam tecnicamente, mas violam tipicamente os termos desses apps, podem bloquear a conta do cliente, quebram com CAPTCHA e 2FA e exigem guardar sessão e meio de pagamento. Não foi implementado.

Caminho recomendado: pedir acesso à Uber e buscar parceria comercial com iFood/99 com base em uso real do Juca.

## Fontes

- [Uber Riders API](https://developer.uber.com/docs/riders/introduction)
- [iFood Developer](https://developermercado.ifood.com.br/docs/guides/order-api/)
- [Rappi Developer Portal](https://dev-portal.rappi.com/pt/api-reference/orders)
