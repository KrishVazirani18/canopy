// How a Canopy event becomes a PostHog event, and a batch of them the body of one request.
//
// One mapping for every way events reach PostHog, so an event looks the same whichever way it came: Canopy sending
// them itself (src/telemetry/index.mjs), or a server passing them on with a copy of this exact file. Dependency-free
// for that reason, and nothing here sends.
//
// PostHog's batch API (https://posthog.com/docs/api/capture): POST {host}/batch/ with
// { api_key, batch: [{ event, distinct_id, timestamp, uuid, properties }] }. Person properties ride on events as
// properties.$set, $set_once and $unset, and PostHog applies them in the order events arrive.

/** PostHog Cloud, US. The EU's is https://eu.i.posthog.com; a project lives on one of them and its key works on no other. */
export const DEFAULT_HOST = 'https://us.i.posthog.com';

/** Where a batch is posted, for a host given with or without a slash at its end. */
export const batchUrl = (host) => `${String(host || DEFAULT_HOST).replace(/\/+$/, '')}/batch/`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The time PostHog files an event under: when it happened, for every event but one.
 *
 * PostHog treats two events as one only when they share their uuid, name, person and the UTC day of their timestamp
 * (https://posthog.com/docs/data/events). A day's summary can be sent twice, days apart (Canopy quit between sending
 * it and writing that down), under the same uuid both times. So it is filed under the day it is about, at noon UTC:
 * however late either copy is sent, both land on the same day and PostHog keeps one.
 */
function timestampOf(event) {
  const day = event.event === 'day_summary' ? event.props?.date : null;
  const noon = typeof day === 'string' && DAY.test(day) ? Date.parse(`${day}T12:00:00.000Z`) : NaN;
  return new Date(Number.isNaN(noon) ? event.ts : noon).toISOString();
}

/**
 * One event as PostHog wants it.
 *
 * @param {{ id: string, install_id: string, event: string, ts: string, launch_id: string, env: string,
 *           app_version: string, os_version: string, schema: number, props: Record<string, unknown> }} event
 *   The event with the versions and env its batch was sent with.
 * @param {{ name: string, env: string, app_version: string, os_version: string, first_seen: string }} person
 *   What is known about the install now. On a replay this is newer than the event, on purpose: PostHog applies
 *   person properties in the order events arrive, so an old event must not bring an old name or version back.
 */
export function toPostHogEvent(event, person) {
  const set = { env: person.env, app_version: person.app_version, os_version: person.os_version };
  const firstSeen = Date.parse(person.first_seen);
  const properties = {
    ...event.props,
    env: event.env,
    app_version: event.app_version,
    os_version: event.os_version,
    launch_id: event.launch_id,
    schema: event.schema,
    // PostHog reads distinct_id from the top level and falls back to this one; both are set so either works.
    distinct_id: event.install_id,
    // No location, ever. PostHog works one out from the address a request comes from (the person's own, when Canopy
    // sends; a server's otherwise) unless the event says not to. The address itself is the project's to discard:
    // "Discard client IP data" in the PostHog project's settings.
    $geoip_disable: true,
    // One person per install, said outright: it is what lets the name and versions below be kept at all.
    $process_person_profile: true,
    // A person who shares no name has no name in PostHog either: clearing it in Canopy removes it there.
    ...(person.name ? { $set: { ...set, name: person.name } } : { $set: set, $unset: ['name'] }),
    // Kept from the first event that says it. Left out when there is no date to give, never sent as a broken one.
    ...(!Number.isNaN(firstSeen) && { $set_once: { first_seen: new Date(firstSeen).toISOString() } }),
  };
  return {
    event: event.event,
    distinct_id: event.install_id,
    // The id Canopy made. An event sent twice (a retry whose first answer was lost, a replay) has the same uuid,
    // name, person and timestamp both times, and PostHog merges the two in the background.
    uuid: event.id,
    // Always the same text for the same instant, wherever it was read from, so that merge can happen. No sent_at
    // is sent: with it PostHog shifts timestamps by the difference to its own clock, and a second copy would shift
    // by a different amount.
    timestamp: timestampOf(event),
    properties,
  };
}

/**
 * The body of one POST to /batch/: a batch that schema.cleanBatch() has passed, as PostHog wants it.
 *
 * @param {string} key the project's key
 * @param {{ install_id: string, name: string, env: string, app_version: string, os_version: string, schema: number }} header
 *   who sent the batch (cleanBatch's `header`)
 * @param {{ id: string, event: string, ts: string, launch_id: string, props: Record<string, unknown> }[]} events
 *   cleanBatch's `events`
 * @param {string | null} [firstSeen] when this install first ran (ISO)
 */
export function toPostHogBatch(key, header, events, firstSeen) {
  const { install_id, name, env, app_version, os_version, schema } = header;
  const person = { name, env, app_version, os_version, first_seen: firstSeen };
  return { api_key: key, batch: events.map((e) => toPostHogEvent({ ...e, install_id, env, app_version, os_version, schema }, person)) };
}
