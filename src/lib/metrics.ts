import client from "prom-client";

// RNF-28: métricas Prometheus
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const messagesIn = new client.Counter({ name: "juca_messages_in_total", help: "Mensagens recebidas", labelNames: ["channel"], registers: [registry] });
export const replyLatency = new client.Histogram({ name: "juca_reply_latency_seconds", help: "Latência mensagem→resposta", labelNames: ["channel"], buckets: [0.5, 1, 2, 3, 5, 10, 20], registers: [registry] });
export const toolCalls = new client.Counter({ name: "juca_tool_calls_total", help: "Uso de ferramentas por feature", labelNames: ["tool", "outcome"], registers: [registry] });
export const llmTokens = new client.Counter({ name: "juca_llm_tokens_total", help: "Tokens consumidos", labelNames: ["kind"], registers: [registry] });
export const errors = new client.Counter({ name: "juca_errors_total", help: "Erros", labelNames: ["where"], registers: [registry] });
export const remindersSent = new client.Counter({ name: "juca_reminders_sent_total", help: "Lembretes entregues", labelNames: ["outcome"], registers: [registry] });
