/**
 * Valida as credenciais da Meta inseridas no .env.
 *   npm run whatsapp:check
 *   npm run whatsapp:check -- 5511999990000     (envia também o template hello_world de teste)
 */
import { config } from "../src/config.js";
import { whatsappPhoneInfo } from "../src/channels/whatsapp.js";

const required = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"] as const;
const missing = required.filter((k) => !config[k]);
if (missing.length) {
  console.error(`Faltam no .env: ${missing.join(", ")}`);
  process.exit(1);
}

const info = await whatsappPhoneInfo();
console.log(`OK: número ${info.display_phone_number} (${info.verified_name}), qualidade ${info.quality_rating ?? "n/d"}`);
console.log(`Webhook a cadastrar na Meta: ${config.PUBLIC_BASE_URL}/webhooks/whatsapp`);
console.log("Campo a assinar: messages");
console.log(
  config.WHATSAPP_REMINDER_TEMPLATE
    ? `Template de lembretes: ${config.WHATSAPP_REMINDER_TEMPLATE} (${config.WHATSAPP_TEMPLATE_LANGUAGE})`
    : "Atenção: sem WHATSAPP_REMINDER_TEMPLATE, lembretes fora da janela de 24h não chegam pelo WhatsApp.",
);

const to = process.argv[2];
if (to) {
  const res = await fetch(`https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }),
  });
  console.log(`Envio de teste: HTTP ${res.status} ${await res.text()}`);
}
