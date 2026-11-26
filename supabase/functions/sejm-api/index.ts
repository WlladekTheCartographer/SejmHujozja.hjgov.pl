
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const fail = (message: string, status = 400) => json({ error: message }, status);
const env = (key: string) => Deno.env.get(key) ?? "";

const url = env("SUPABASE_URL");
const anon = env("SUPABASE_ANON_KEY");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeParty(p: any) {
  return {
    id: p.id ?? p.party_id,
    n: p.name ?? p.party_name,
    s: Number(p.seats),
    hasPin: Boolean(p.pin_hash || p.pin_plain),
  };
}

async function getSession() {
  const { data, error } = await admin
    .from("voting_sessions")
    .select("*")
    .order("vote_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getControl() {
  const { data, error } = await admin
    .from("app_control")
    .select("*")
    .eq("id", true)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: inserted, error: insertError } = await admin
    .from("app_control")
    .insert({ id: true })
    .select("*")
    .single();

  if (insertError) throw insertError;
  return inserted;
}

async function setSound(type: string) {
  const c = await getControl();

  const { data, error } = await admin
    .from("app_control")
    .update({
      sound_seq: Number(c.sound_seq || 0) + 1,
      sound_type: type,
      sound_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", true)
    .select("sound_seq")
    .single();

  if (error) throw error;
  return data.sound_seq;
}

async function maybeClose(session: any, control: any) {
  if (
    session?.status === "open" &&
    control?.closing_at &&
    new Date(control.closing_at).getTime() <= Date.now()
  ) {
    const { error } = await admin
      .from("voting_sessions")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", session.id)
      .eq("status", "open");

    if (error) throw error;

    const { error: controlError } = await admin
      .from("app_control")
      .update({
        closing_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);

    if (controlError) throw controlError;

    if (control.auto_sound) await setSound("vend");

    session.status = "closed";
    control.closing_at = null;
  }

  return { session, control };
}

async function loadState(isAdmin: boolean) {
  let session = await getSession();
  let control = await getControl();

  ({ session, control } = await maybeClose(session, control));

  if (!session) {
    return {
      cur: null,
      votes: {},
      voted: [],
      seq: Number(control.sound_seq || 0),
      soundType: control.sound_type,
      soundAge: 999,
      closing: control.closing_at ? { at: control.closing_at } : null,
    };
  }

  const { data: sp, error: spErr } = await admin
    .from("session_parties")
    .select("party_id,party_name,seats")
    .eq("session_id", session.id);

  if (spErr) throw spErr;

  const parties = (sp || []).map(safeParty);
  const ids = parties.map((p: any) => p.id);

  if (ids.length) {
    const { data: live, error: liveErr } = await admin
      .from("parties")
      .select("id,pin_hash,pin_plain")
      .in("id", ids);

    if (liveErr) throw liveErr;

    const pinMap = new Map(
      (live || []).map((p: any) => [
      p.id,
      Boolean(p.pin_hash || p.pin_plain),
    ]),
    );

    parties.forEach(
      (p: any) => (p.hasPin = pinMap.get(p.id) || false),
    );
  }

  const { data: rows, error: voteErr } = await admin
    .from("votes")
    .select("*")
    .eq("session_id", session.id);

  if (voteErr) throw voteErr;

  const votes: Record<string, any> = {};
  const voted = (rows || []).map((r: any) => r.party_id);

  if (isAdmin || session.status === "published") {
    for (const r of rows || []) {
      votes[r.party_id] = {
        z: r.yes_votes,
        p: r.no_votes,
        w: r.abstain_votes,
        c: r.choice_votes || [],
      };
    }
  }

  const age = control.sound_at
    ? Math.max(
        0,
        (Date.now() - new Date(control.sound_at).getTime()) / 1000,
      )
    : 999;

  return {
    cur: {
      id: session.id,
      num: session.vote_number,
      title: session.title,
      kind: session.kind,
      options: session.options || [],
      rule: session.rule,
      open: session.status === "open",
      published: session.status === "published",
      parties,
    },
    votes,
    voted,
    seq: Number(control.sound_seq || 0),
    soundType: control.sound_type,
    soundAge: age,
    closing: control.closing_at ? { at: control.closing_at } : null,
  };
}

async function authenticate(req: Request) {
  const header = req.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");

  if (!token) return null;

  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  const { data, error } = await client.auth.getUser(token);

  if (error || !data.user) return null;
  return data.user;
}

async function requireAdmin(req: Request) {
  const user = await authenticate(req);

  if (!user) {
    throw new Error("Zaloguj się na konto marszałka.");
  }

  const { data, error } = await admin
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    throw new Error("To konto nie ma uprawnień marszałka.");
  }

  return user;
}

async function history() {
  const { data, error } = await admin
    .from("voting_sessions")
    .select("vote_number,title,kind,rule,options,result,published_at")
    .eq("status", "published")
    .order("vote_number", { ascending: false });

  if (error) throw error;

  return (data || []).map((s: any) => {
    const r = s.result || {};

    const lines = [
      `GŁOSOWANIE NR ${s.vote_number}`,
      s.title,
      `Opublikowano: ${s.published_at || ""}`,
      `Rodzaj: ${s.kind === "choice" ? "wybór" : "za / przeciw"}`,
      `Większość: ${s.rule}`,
      `Wynik: ${r.res || "brak danych"}`,
      `Głosowało: ${r.cast ?? "—"}; za: ${r.Z ?? "—"}; przeciw: ${
        r.P ?? "—"
      }; wstrzymało się: ${r.W ?? "—"}`,
      s.options?.length ? `Opcje: ${s.options.join(", ")}` : "",
    ].filter(Boolean);

    return { text: lines.join("\n") };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return fail("Użyj metody POST.", 405);
  }

  try {
    if (!url || !anon || !serviceKey) {
      return fail("Brak konfiguracji sekretów Supabase dla funkcji.", 500);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "state") {
      return json(await loadState(false));
    }

    if (action === "history") {
      return json({ items: await history() });
    }

    if (action === "tick") {
      const c = await getControl();

      const age = c.sound_at
        ? Math.max(
            0,
            (Date.now() - new Date(c.sound_at).getTime()) / 1000,
          )
        : 999;

      return json({
        seq: Number(c.sound_seq || 0),
        type: c.sound_type,
        age,
        auto: c.auto_sound,
        closing: c.closing_at
          ? {
              at: c.closing_at,
              remain: Math.max(
                0,
                (new Date(c.closing_at).getTime() - Date.now()) / 1000,
              ),
            }
          : null,
      });
    }

    if (action === "vote") {
      const session = await getSession();

      if (!session || session.status !== "open") {
        return fail("Głosowanie jest zamknięte.", 409);
      }

      const pid = String(body.pid || "");

      const { data: party, error: partyErr } = await admin
        .from("parties")
        .select("*")
        .eq("id", pid)
        .eq("active", true)
        .maybeSingle();

      if (partyErr) throw partyErr;

      if (!party) {
        return fail("Nie znaleziono aktywnej partii.");
      }

      const { data: sp, error: spErr } = await admin
        .from("session_parties")
        .select("seats")
        .eq("session_id", session.id)
        .eq("party_id", pid)
        .maybeSingle();

      if (spErr) throw spErr;

      if (!sp) {
        return fail("Ta partia nie bierze udziału w bieżącym głosowaniu.");
      }

      if (party.pin_plain || party.pin_hash) {
  const pin = String(body.pin || "");

  if (!pin) {
    return fail("Wpisz PIN partii.", 401);
  }

  if (party.pin_plain) {
    if (pin !== party.pin_plain) {
      return fail("Nieprawidłowy PIN partii.", 401);
    }
  } else {
    // Zgodność ze starymi PIN-ami, które nie zostały
    // jeszcze ponownie ustawione.
    const candidate = await sha256(`${party.pin_salt}:${pin}`);

    if (candidate !== party.pin_hash) {
      return fail("Nieprawidłowy PIN partii.", 401);
    }
  }
}

      const seats = Number(sp.seats);
      const kind = session.kind;

      let yes = 0;
      let no = 0;
      let abstain = 0;
      let choices: number[] = [];

      if (kind === "choice") {
        choices = Array.isArray(body.c)
          ? body.c.map((x: any) => Number(x))
          : [];

        abstain = Number(body.w);

        if (choices.length !== (session.options || []).length) {
          return fail("Nieprawidłowa liczba opcji.");
        }
      } else {
        yes = Number(body.z);
        no = Number(body.p);
        abstain = Number(body.w);
      }

      const all = [
        ...(kind === "choice" ? choices : [yes, no]),
        abstain,
      ];

      if (all.some((x) => !Number.isInteger(x) || x < 0)) {
        return fail(
          "Liczby głosów muszą być nieujemnymi liczbami całkowitymi.",
        );
      }

      const total = all.reduce((a, b) => a + b, 0);

if (total > seats) {
  return fail(
    `Rozdzielono ${total} głosów, ale partia ma tylko ${seats} posłów.`,
  );
}

      const { error } = await admin
        .from("votes")
        .upsert(
          {
            session_id: session.id,
            party_id: pid,
            yes_votes: yes,
            no_votes: no,
            abstain_votes: abstain,
            choice_votes: choices,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "session_id,party_id" },
        );

      if (error) throw error;
      return json({ ok: true });
    }

    await requireAdmin(req);

    if (action === "admin_state") {
      const state = await loadState(true);

      const { data: parties, error } = await admin
        .from("parties")
        .select("id,name,seats,pin_hash,pin_plain,active,sort_order")
        .eq("active", true)
        .order("sort_order")
        .order("name");

      if (error) throw error;

      const c = await getControl();

      return json({
        ...state,
        parties: (parties || []).map((p: any) => ({
        id: p.id,
        n: p.name,
        s: p.seats,
        pin: p.pin_plain || "",
        hasPin: Boolean(p.pin_hash || p.pin_plain),
        active: p.active,
      })),
        autoSound: c.auto_sound,
      });
    }

    if (action === "save_parties") {
      if (!Array.isArray(body.parties)) {
        return fail("Brak listy partii.");
      }

      const incoming = body.parties;

      if (incoming.length > 100) {
        return fail("Zbyt wiele partii.");
      }

      const clean = incoming.map((p: any, i: number) => ({
        id:
          p.id && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(p.id)
            ? p.id
            : crypto.randomUUID(),
        name: String(p.n || "").trim().slice(0, 160),
        seats: Number(p.s),
        sort_order: i,
        pin: String(p.pin || ""),
        clearPin: Boolean(p.clearPin),
      }));

      if (
        clean.some(
          (p: any) =>
            !p.name ||
            !Number.isInteger(p.seats) ||
            p.seats < 0,
        )
      ) {
        return fail(
          "Każda partia musi mieć nazwę i nieujemną liczbę posłów.",
        );
      }

      const { data: old, error: oldErr } = await admin
        .from("parties")
        .select("id");

      if (oldErr) throw oldErr;

      const incomingIds = new Set(clean.map((p: any) => p.id));

      for (const p of clean) {
        const { data: existing, error: findErr } = await admin
          .from("parties")
          .select("pin_salt,pin_hash,pin_plain")
          .eq("id", p.id)
          .maybeSingle();

        if (findErr) throw findErr;

        let pin_salt = existing?.pin_salt || crypto.randomUUID();
let pin_hash = existing?.pin_hash || "";
let pin_plain = existing?.pin_plain || "";

if (p.clearPin) {
  pin_salt = crypto.randomUUID();
  pin_hash = "";
  pin_plain = "";
} else if (p.pin) {
  pin_salt = crypto.randomUUID();
  pin_hash = await sha256(`${pin_salt}:${p.pin}`);
  pin_plain = p.pin;
}

        if (p.clearPin) {
          pin_salt = crypto.randomUUID();
          pin_hash = "";
        } else if (p.pin) {
          pin_salt = crypto.randomUUID();
          pin_hash = await sha256(`${pin_salt}:${p.pin}`);
        }

        const payload: any = {
          id: p.id,
          name: p.name,
          seats: p.seats,
          sort_order: p.sort_order,
          active: true,
          pin_salt,
          pin_hash,
          pin_plain,
        };

        const { error } = await admin
          .from("parties")
          .upsert(payload, { onConflict: "id" });

        if (error) throw error;
      }

      for (const p of old || []) {
        if (!incomingIds.has(p.id)) {
          const { error } = await admin
            .from("parties")
            .update({ active: false })
            .eq("id", p.id);

          if (error) throw error;
        }
      }

      return json({ ok: true });
    }

    if (action === "start") {
      const title = String(body.title || "").trim().slice(0, 250);
      const kind = body.kind === "choice" ? "choice" : "yn";
      const rule = String(body.rule || "");

      const options =
        kind === "choice" && Array.isArray(body.options)
          ? body.options.map((x: any) => String(x).trim()).filter(Boolean)
          : [];

      if (!title) return fail("Podaj nazwę głosowania.");

      if (
        kind === "yn" &&
        !["simple", "abs", "35", "23"].includes(rule)
      ) {
        return fail("Nieprawidłowa większość.");
      }

      if (
        kind === "choice" &&
        !["plur", "abs"].includes(rule)
      ) {
        return fail("Nieprawidłowa większość.");
      }

      if (
        kind === "choice" &&
        (
          options.length < 2 ||
          options.length > 10 ||
          new Set(options).size !== options.length
        )
      ) {
        return fail("Wybór musi mieć od 2 do 10 różnych opcji.");
      }

      const { data: parties, error: pErr } = await admin
        .from("parties")
        .select("id,name,seats")
        .eq("active", true)
        .order("sort_order");

      if (pErr) throw pErr;

      if (!parties?.length) {
        return fail("Najpierw dodaj co najmniej jedną partię.");
      }

      // vote_number jest generowane przez bazę danych.
      // Nie odczytujemy ostatniego numeru ani nie wpisujemy go ręcznie.
      const { data: session, error } = await admin
        .from("voting_sessions")
        .insert({
          title,
          kind,
          rule,
          options,
          status: "open",
          created_by: (await authenticate(req))?.id || null,
        })
        .select("*")
        .single();

      if (error) throw error;

      const snapshots = parties.map((p: any) => ({
        session_id: session.id,
        party_id: p.id,
        party_name: p.name,
        seats: p.seats,
      }));

      const { error: spErr } = await admin
        .from("session_parties")
        .insert(snapshots);

      if (spErr) throw spErr;

      const { error: clearErr } = await admin
        .from("app_control")
        .update({
          closing_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true);

      if (clearErr) throw clearErr;

      const c = await getControl();
      if (c.auto_sound) await setSound("vstart");

      return json({ ok: true, id: session.id });
    }

    if (action === "toggle") {
      const s = await getSession();

      if (!s) return fail("Brak głosowania.");

      if (s.status === "published") {
        return fail("Opublikowanego głosowania nie można ponownie otworzyć.");
      }

      const open = s.status !== "open";

      const { error } = await admin
        .from("voting_sessions")
        .update({
          status: open ? "open" : "closed",
          closed_at: open ? null : new Date().toISOString(),
        })
        .eq("id", s.id);

      if (error) throw error;

      const c = await getControl();

      const { error: controlError } = await admin
        .from("app_control")
        .update({ closing_at: null })
        .eq("id", true);

      if (controlError) throw controlError;

      if (c.auto_sound) {
        await setSound(open ? "vstart" : "vend");
      }

      return json({ ok: true });
    }

    if (action === "publish") {
      const s = await getSession();

      if (!s) return fail("Brak głosowania.");
      if (s.status === "published") return fail("Wyniki są już opublikowane.");

      const { data: rows, error: vErr } = await admin
        .from("votes")
        .select("*")
        .eq("session_id", s.id);

      if (vErr) throw vErr;

      const { data: sp, error: spErr } = await admin
        .from("session_parties")
        .select("seats")
        .eq("session_id", s.id);

      if (spErr) throw spErr;

      const N = (sp || []).reduce(
        (a: number, p: any) => a + Number(p.seats),
        0,
      );

      let Z = 0;
      let P = 0;
      let W = 0;
      const C = (s.options || []).map(() => 0);

      for (const r of rows || []) {
        Z += Number(r.yes_votes || 0);
        P += Number(r.no_votes || 0);
        W += Number(r.abstain_votes || 0);

        (r.choice_votes || []).forEach((x: number, i: number) => {
          if (i < C.length) C[i] += Number(x || 0);
        });
      }

      const cast =
        Z + P + W + C.reduce((a: number, b: number) => a + b, 0);

      const rule = String(s.rule || "simple");

      let res = "";
      let need: number | null = null;
      let winner: number | null = null;

      if (s.kind === "choice") {
        const maxVotes = Math.max(0, ...C);
        const winners = C
          .map((votes: number, i: number) => ({ votes, i }))
          .filter((x: any) => x.votes === maxVotes);

        if (maxVotes > 0 && winners.length === 1) {
          winner = winners[0].i;

          if (
            rule === "plur" ||
            (rule === "abs" && maxVotes > cast / 2)
          ) {
            res = `Wybrano: ${s.options[winner]}`;
          } else {
            res = "Nie osiągnięto wymaganej większości";
          }
        } else {
          res = "Remis — brak rozstrzygnięcia";
        }

        if (rule === "abs") {
          need = Math.floor(cast / 2) + 1;
        }
      } else {
        switch (rule) {
          case "simple":
            need = P + 1;
            res = Z > P ? "Wniosek przyjęty" : "Wniosek odrzucony";
            break;

          case "abs":
            need = P + W + 1;
            res = Z > P + W ? "Wniosek przyjęty" : "Wniosek odrzucony";
            break;

          case "35":
            need = Math.ceil(cast * 3 / 5);
            res = Z >= need && cast > 0
              ? "Wniosek przyjęty"
              : "Wniosek odrzucony";
            break;

          case "23":
            need = Math.ceil(cast * 2 / 3);
            res = Z >= need && cast > 0
              ? "Wniosek przyjęty"
              : "Wniosek odrzucony";
            break;

          default:
            return fail("Nieznana reguła większości.");
        }
      }

      const result = {
        Z,
        P,
        W,
        C,
        cast,
        N,
        absent: Math.max(0, N - cast),
        res,
        need,
        rule,
        winner,
      };

      const { error } = await admin
        .from("voting_sessions")
        .update({
          status: "published",
          closed_at: new Date().toISOString(),
          published_at: new Date().toISOString(),
          result,
        })
        .eq("id", s.id);

      if (error) throw error;

      const { error: controlError } = await admin
        .from("app_control")
        .update({ closing_at: null })
        .eq("id", true);

      if (controlError) throw controlError;

      const c = await getControl();
      if (c.auto_sound) await setSound("vend");

      return json({ ok: true });
    }

    if (action === "sound") {
      const type = String(body.type || "");

      if (
        !["gavel", "bell", "timer", "call", "vstart", "vend", "tick"].includes(type)
      ) {
        return fail("Nieznany dźwięk.");
      }

      return json({ seq: await setSound(type) });
    }

    if (action === "snd_auto") {
      if (typeof body.on !== "boolean") {
        return fail("Nieprawidłowa wartość.");
      }

      const { error } = await admin
        .from("app_control")
        .update({
          auto_sound: body.on,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true);

      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "close_in") {
      const secs = Number(body.secs);

      if (!Number.isInteger(secs) || secs < 3 || secs > 300) {
        return fail("Odliczanie musi mieć 3–300 sekund.");
      }

      const s = await getSession();

      if (!s || s.status !== "open") {
        return fail("Głosowanie nie jest otwarte.");
      }

      const at = new Date(Date.now() + secs * 1000).toISOString();

      const { error } = await admin
        .from("app_control")
        .update({
          closing_at: at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true);

      if (error) throw error;
      return json({ ok: true, at });
    }

    if (action === "close_cancel") {
      const { error } = await admin
        .from("app_control")
        .update({
          closing_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true);

      if (error) throw error;
      return json({ ok: true });
    }

    return fail("Nieznana operacja.");
  } catch (e) {
    console.error("Błąd sejm-api:", e);

    const err = e as {
      message?: string;
      details?: string;
      hint?: string;
      code?: string;
    };

    const message =
      err?.message ||
      (typeof e === "string" ? e : "Nieznany błąd serwera.");

    console.error("Szczegóły błędu:", {
      message: err?.message,
      details: err?.details,
      hint: err?.hint,
      code: err?.code,
    });

    return fail(
      message,
      message.includes("Zalog") || message.includes("uprawnień")
        ? 401
        : 500,
    );
  }
});
