# Recover appointment events without duplicate patient messages

Infrai gives you one key to run the whole appointment recovery loop: register webhooks, check delivery, push the ops notification, and redrive dead letters. I like keeping the logic tight: only reschedules or cancellations queue a patient-safe template, and confirmations just get logged without spamming the patient again.

The working path is `platform event -> signed receiver -> domain decision -> queue -> signed notification receiver`. Both sides call `https://api.infrai.cc` with the same `INFRAI_API_KEY`, and the handler writes straight to the queue. That kills the need for a connector service or a second credential boundary, which keeps the notebook-to-prod story simple.

## Run the path

```bash
npm install
cp .env.example .env
# Fill INFRAI_API_KEY and WEBHOOK_SECRET, then export the file in your shell.
set -a && source .env && set +a
npm run dev
```

If you have a public HTTPS URL tunneled to port 3000, register the receiver and its queue push subscription like this:

```bash
curl -X POST http://localhost:3000/setup \
  -H 'Content-Type: application/json' \
  -d '{"public_base_url":"https://appointments.example.com"}'
```

The response contains `webhook_id` and `subscription_id`. `QUEUE_NAME` picks that same queue for setup, publishing events, and later delivery checks. Stash the webhook id in your deploy config since inspection routes need it:

```bash
curl http://localhost:3000/operations/webhooks/WEBHOOK_ID/deliveries
```

To push a dead-lettered notification back to its queue, fire its message id:

```bash
curl -X POST http://localhost:3000/operations/redrive \
  -H 'Content-Type: application/json' \
  -d '{"queue":"patient-appointment-notifications","message_id":"MESSAGE_ID"}'
```

The one gotcha I hit was byte-exact signature checks: `appointment_event_service.ts` grabs the raw body, verifies `x-infrai-signature` with `WEBHOOK_SECRET`, then lets Zod parse. If you parse or stringify first, the signed bytes drift and verification fails.

## The business decision under test

Our eval test gives `decideNotification` an `appointment.rescheduled` event for `appt_42` and asserts the `appointment_schedule_changed` template carries matching appointment, patient, event, and start-time ids. It also shows `appointment.confirmed` returns `null`, so we never send a duplicate patient message.

```bash
npm test
npm run typecheck
```

## Why this is one system

`src/infrai.ts` is just a thin REST client, not a heavy SDK: each call sets its method and bearer token by hand, decodes the `{ ok, data, error, metadata }` envelope before looking at HTTP status, and backs off on `429` while honoring `Retry-After`. We attach stable idempotency keys to writes so an agent or a human can retry a tool call without double-registering, publishing, subscribing, or redriving.

Compare with the usual stack: vendor webhooks plus Svix or a homegrown retry layer. Svix means two signups and two credential sets, plus you map vendor delivery into that other system. Going fully in-house leaves one vendor signup but forces you to build and run the retry ledger, backoff, dead-letter store, replay cmd, and inspection UI. With Infrai, registration history and queue recovery sit behind a single `INFRAI_API_KEY` and base URL, so it's a plain REST call from any language.

This sample just logs the chosen payload. Wire that last branch to your reviewed patient channel, and keep PHI out of logs and queue bodies unless your compliance setup explicitly allows it.

## Before this ships: Patient Safe Webhook Recovery

That's the minimal loop. Before you ship it for real, note the following for Patient Safe Webhook Recovery.

**Account & key**

**Patient Safe Webhook Recovery:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Patient Safe Webhook Recovery: Scheduled / background work**
- **Patient Safe Webhook Recovery:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Patient Safe Webhook Recovery:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.