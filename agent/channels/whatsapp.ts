import { createMemoryState } from "@chat-adapter/state-memory";
import { createKapsoAdapter } from "@kapso/chat-adapter";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

import { messageToInvoiceContent } from "#lib/whatsapp-content.js";

/**
 * Superficie de WhatsApp del agente de facturas, vía Kapso.
 *
 * Kapso es un adaptador de Chat SDK (`@kapso/chat-adapter`), así que se monta
 * con el canal `chat-sdk` de eve en vez de con un canal propio. El adaptador se
 * llama `kapso`, por lo que el webhook queda en `POST /eve/v1/kapso`: esa es la
 * URL que hay que configurar en el panel de Kapso, con el evento
 * `whatsapp.message.received`.
 *
 * Lee `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` y `KAPSO_WEBHOOK_SECRET` del
 * entorno. El adaptador verifica la firma `X-Webhook-Signature` de cada entrega
 * antes de despachar nada; sin `KAPSO_WEBHOOK_SECRET` esa verificación falla y
 * el webhook responde 401.
 *
 * `streaming: false` porque WhatsApp no permite editar un mensaje ya enviado
 * (`editMessage` del adaptador lanza `NotImplementedError`). Con streaming
 * activo el canal publicaría un primer mensaje parcial que nunca podría
 * actualizar; así la respuesta se publica una sola vez, al terminar el turno.
 */
export const { bot, channel, send } = chatSdkChannel({
  userName: "Facturas",
  adapters: {
    kapso: createKapsoAdapter({
      phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID,
      webhookSecret: process.env.KAPSO_WEBHOOK_SECRET,
    }),
  },
  // El estado de Chat SDK guarda suscripciones, locks y deduplicación de
  // entregas. En memoria alcanza para un bot que solo atiende DMs de WhatsApp,
  // pero no sobrevive entre invocaciones serverless: ver el README para cambiar
  // a `@chat-adapter/state-redis` cuando haga falta deduplicación durable.
  state: createMemoryState(),
  streaming: false,
});

/**
 * Cada conversación de WhatsApp es un DM. Los adjuntos se descargan acá dentro,
 * autenticados con la API key de Kapso, y viajan como bytes: eve los stagea en
 * `/workspace/attachments` para que `extract_invoice` los lea.
 */
bot.onDirectMessage(async (thread: Thread, message: Message) => {
  await send(await messageToInvoiceContent(message), { thread, title: "Factura por WhatsApp" });
});

export default channel;
