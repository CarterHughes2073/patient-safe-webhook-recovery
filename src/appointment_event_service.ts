import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { appointmentEventSchema, decideNotification } from "./appointment_policy.js";
import { createInfraiClient, InfraiError } from "./infrai.js";

const setupSchema = z.object({
  public_base_url: z.string().url(),
});

const redriveSchema = z.object({
  queue: z.string().min(1),
  message_id: z.string().min(1),
});

const apiKey = process.env.INFRAI_API_KEY;
const webhookSecret = process.env.WEBHOOK_SECRET;
if (!apiKey || !webhookSecret) {
  throw new Error("Set INFRAI_API_KEY and WEBHOOK_SECRET before starting the service");
}

const infrai = createInfraiClient(apiKey);
const queueName = process.env.QUEUE_NAME ?? "patient-appointment-notifications";

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validSignature(body: Buffer, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = createHmac("sha256", webhookSecret).update(body).digest("hex");
  const actual = Buffer.from(supplied.replace(/^sha256=/, ""), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "POST" && url.pathname === "/setup") {
    const input = setupSchema.parse(JSON.parse((await rawBody(request)).toString("utf8")));
    const registration = await infrai.account.webhooks.register({
      url: `${input.public_base_url}/events/appointments`,
      events: ["appointment.confirmed", "appointment.rescheduled", "appointment.cancelled"],
      description: "Patient-safe appointment operations",
      secret: webhookSecret,
      idempotency_key: `appointment-webhook:${input.public_base_url}`,
    });
    const subscription = await infrai.queue.push_subscribe(queueName, {
      queue: queueName,
      url: `${input.public_base_url}/notifications/appointments`,
      secret: webhookSecret,
      max_retries: 8,
      visibility_timeout: 60,
      dead_letter_queue: `${queueName}-dead-letters`,
      idempotency_key: `appointment-push:${queueName}:${input.public_base_url}`,
    });
    json(response, 201, { webhook_id: registration.id, subscription_id: subscription.subscription_id });
    return;
  }

  if (request.method === "POST" && url.pathname === "/events/appointments") {
    const body = await rawBody(request);
    if (!validSignature(body, request.headers["x-infrai-signature"] as string | undefined)) {
      json(response, 401, { error: "invalid signature" });
      return;
    }
    const event = appointmentEventSchema.parse(JSON.parse(body.toString("utf8")));
    const notification = decideNotification(event);
    if (!notification) {
      json(response, 202, { event_id: event.id, decision: "record_only" });
      return;
    }
    const queued = await infrai.queue.publish({
      queue: queueName,
      payload: notification,
      idempotency_key: event.id,
    });
    json(response, 202, { event_id: event.id, decision: "notify", message_id: queued.message_id });
    return;
  }

  if (request.method === "POST" && url.pathname === "/notifications/appointments") {
    const body = await rawBody(request);
    if (!validSignature(body, request.headers["x-infrai-signature"] as string | undefined)) {
      json(response, 401, { error: "invalid signature" });
      return;
    }
    const notification = z.object({
      event_id: z.string(),
      appointment_id: z.string(),
      patient_id: z.string(),
      template: z.enum(["appointment_schedule_changed", "appointment_cancelled"]),
      starts_at: z.string().datetime(),
    }).parse(JSON.parse(body.toString("utf8")));
    console.log(JSON.stringify({ delivered: true, notification }));
    json(response, 200, { accepted: true });
    return;
  }

  const deliveryMatch = url.pathname.match(/^\/operations\/webhooks\/([^/]+)\/deliveries$/);
  if (request.method === "GET" && deliveryMatch) {
    json(response, 200, await infrai.account.webhooks.deliveries(deliveryMatch[1]));
    return;
  }

  if (request.method === "POST" && url.pathname === "/operations/redrive") {
    const input = redriveSchema.parse(JSON.parse((await rawBody(request)).toString("utf8")));
    const result = await infrai.queue.dlq.redrive(input.queue, {
      queue: input.queue,
      message_id: input.message_id,
      idempotency_key: `redrive:${input.queue}:${input.message_id}`,
    });
    json(response, 202, result);
    return;
  }

  json(response, 404, { error: "not found" });
}

const port = Number(process.env.PORT ?? "3000");
createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      json(response, 400, { error: "invalid request", issues: error.issues });
    } else if (error instanceof InfraiError) {
      json(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
        error: error.code,
        message: error.message,
      });
    } else {
      console.error(error);
      json(response, 500, { error: "internal error" });
    }
  });
}).listen(port, () => console.log(`Appointment event service listening on http://localhost:${port}`));
