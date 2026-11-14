import { getRedis, dbGetJson, dbPutJson, dbListKeys, verifyUser } from "./_db.js";

function defaultGameState(id) {
  return {
    id,
    spores: 0,
    totalSpores: 0,
    breadIndex: 0,
    upgrades: { spray: 0, closet: 0, bag: 0, lab: 0, planet: 0 },
    characters: [],
    equipped: [],
    prestige: 0,
    updatedAt: Date.now()
  };
}

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({ error: "データベース(Upstash Redis)が接続されていません。" });
  }

  const action = String(req.query?.action || "").trim();

  if (req.method === "GET") {
    const me = String(req.query?.me || "").trim();
    const password = String(req.query?.password || "").trim();

    const auth = await verifyUser(redis, me, password);
    if (!auth) {
      return res.status(403).json({ error: "認証に失敗しました。" });
    }

    if (action === "state") {
      let state = await dbGetJson(redis, "game:" + me);
      if (!state) {
        state = defaultGameState(me);
        await dbPutJson(redis, "game:" + me, state);
      }

      const gameKeys = await dbListKeys(redis, "game:");
      const ranking = [];
      for (const k of gameKeys) {
        const g = await dbGetJson(redis, k);
        if (g && g.id) {
          const leadUid = (g.equipped || [])[0];
          const leadChar = (g.characters || []).find(c => c.uid === leadUid);
          ranking.push({
            id: g.id,
            totalSpores: Number(g.totalSpores || 0),
            breadIndex: Number(g.breadIndex || 0),
            prestige: Number(g.prestige || 0),
            leadCharId: leadChar ? leadChar.charId : null
          });
        }
      }
      ranking.sort((a, b) => b.totalSpores - a.totalSpores);

      const tradeKeys = await dbListKeys(redis, "trade:");
      const incomingTrades = [];
      const outgoingTrades = [];
      for (const tk of tradeKeys) {
        const tr = await dbGetJson(redis, tk);
        if (!tr || tr.status !== "open") continue;
        if (tr.to === me) incomingTrades.push(tr);
        if (tr.from === me) outgoingTrades.push(tr);
      }

      return res.status(200).json({
        ok: true,
        state,
        ranking: ranking.slice(0, 30),
        incomingTrades,
        outgoingTrades
      });
    }

    return res.status(400).json({ error: "Invalid action" });
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const me = String(body.me || "").trim();
    const password = String(body.password || "").trim();
    const auth = await verifyUser(redis, me, password);
    if (!auth) {
      return res.status(403).json({ error: "認証に失敗しました。" });
    }

    if (action === "save") {
      const incoming = body.state || {};
      const current = (await dbGetJson(redis, "game:" + me)) || defaultGameState(me);

      const existingMap = new Map((current.characters || []).map(c => [c.uid, c]));
      const clientChars = Array.isArray(incoming.characters) ? incoming.characters : [];
      for (const c of clientChars) {
        if (c && c.uid && c.charId && !existingMap.has(c.uid)) {
          existingMap.set(c.uid, { uid: String(c.uid), charId: String(c.charId), obtainedAt: c.obtainedAt || Date.now() });
        }
      }
      const mergedChars = Array.from(existingMap.values()).slice(0, 200);
      const validUids = new Set(mergedChars.map(c => c.uid));
      const mergedEquipped = (Array.isArray(incoming.equipped) ? incoming.equipped : [])
        .filter(uid => validUids.has(uid))
        .slice(0, 3);

      const curPrestige = Math.max(0, Number(current.prestige || 0));
      let nextPrestige = Math.max(curPrestige, Math.floor(Number(incoming.prestige || 0)));
      const nextTotalSpores = Math.max(Number(current.totalSpores || 0), Number(incoming.totalSpores || 0));
      if (nextPrestige > curPrestige) {
        const reqCost = Math.floor(50000 * Math.pow(3, curPrestige));
        if (nextPrestige > curPrestige + 1 || nextTotalSpores < reqCost) {
          nextPrestige = curPrestige;
        }
      }

      const updated = {
        id: me,
        spores: Math.max(0, Number(incoming.spores || 0)),
        totalSpores: nextTotalSpores,
        breadIndex: Math.max(0, Number(incoming.breadIndex || 0)),
        upgrades: incoming.upgrades || current.upgrades,
        characters: mergedChars,
        equipped: mergedEquipped,
        prestige: nextPrestige,
        updatedAt: Date.now()
      };
      await dbPutJson(redis, "game:" + me, updated);
      return res.status(200).json({ ok: true, state: updated });
    }

    if (action === "trade_offer") {
      const peer = String(body.peer || "").trim();
      const myCharUid = String(body.myCharUid || "").trim();
      const wantCharId = String(body.wantCharId || "ANY").trim();

      if (!peer || peer === me) {
        return res.status(400).json({ error: "有効な相手のIDを入力してください。" });
      }
      if (peer !== "admin") {
        const peerUser = await dbGetJson(redis, "user:" + peer);
        if (!peerUser || peerUser.status !== "approved") {
          return res.status(404).json({ error: "指定された相手IDが見つからないか、まだ許可されていません。" });
        }
      }

      const myState = (await dbGetJson(redis, "game:" + me)) || defaultGameState(me);
      const offeredChar = (myState.characters || []).find(c => c.uid === myCharUid);
      if (!offeredChar) {
        return res.status(400).json({ error: "指定したキャラクターを所持していません。一度セーブしてから試してください。" });
      }

      const existingTrades = await dbListKeys(redis, "trade:");
      for (const tk of existingTrades) {
        const tr = await dbGetJson(redis, tk);
        if (tr && tr.status === "open" && tr.from === me && tr.fromCharUid === myCharUid) {
          return res.status(400).json({ error: "このキャラクターはすでに別のトレードに出品中です。" });
        }
      }

      const tradeId = "tr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const tradeObj = {
        tradeId,
        from: me,
        to: peer,
        fromCharUid: offeredChar.uid,
        fromCharId: offeredChar.charId,
        wantCharId,
        status: "open",
        createdAt: Date.now()
      };
      await dbPutJson(redis, "trade:" + tradeId, tradeObj);
      return res.status(200).json({ ok: true, trade: tradeObj });
    }

    if (action === "trade_respond") {
      const tradeId = String(body.tradeId || "").trim();
      const accept = Boolean(body.accept);
      const giveCharUid = String(body.giveCharUid || "").trim();

      const tr = await dbGetJson(redis, "trade:" + tradeId);
      if (!tr || tr.status !== "open" || tr.to !== me) {
        return res.status(404).json({ error: "有効なトレード申請が見つかりません。" });
      }

      if (!accept) {
        tr.status = "rejected";
        await dbPutJson(redis, "trade:" + tradeId, tr);
        return res.status(200).json({ ok: true, message: "トレードを断りました。" });
      }

      const senderState = await dbGetJson(redis, "game:" + tr.from);
      const myState = (await dbGetJson(redis, "game:" + me)) || defaultGameState(me);
      if (!senderState) {
        return res.status(404).json({ error: "相手のセーブデータが見つかりません。" });
      }

      const senderCharIdx = (senderState.characters || []).findIndex(c => c.uid === tr.fromCharUid);
      if (senderCharIdx === -1) {
        tr.status = "invalid";
        await dbPutJson(redis, "trade:" + tradeId, tr);
        return res.status(400).json({ error: "相手がそのキャラをすでに手放しているため成立しませんでした。" });
      }

      const myCharIdx = (myState.characters || []).findIndex(c => c.uid === giveCharUid);
      if (myCharIdx === -1) {
        return res.status(400).json({ error: "交換に出す自分のキャラクターを選んでください。" });
      }
      const myGivenChar = myState.characters[myCharIdx];
      if (tr.wantCharId !== "ANY" && myGivenChar.charId !== tr.wantCharId) {
        return res.status(400).json({ error: "相手が希望しているキャラクターと一致しません。" });
      }

      const senderGivenChar = senderState.characters[senderCharIdx];

      senderState.characters.splice(senderCharIdx, 1, myGivenChar);
      myState.characters.splice(myCharIdx, 1, senderGivenChar);

      senderState.equipped = (senderState.equipped || []).filter(u => u !== senderGivenChar.uid);
      myState.equipped = (myState.equipped || []).filter(u => u !== myGivenChar.uid);

      tr.status = "completed";
      tr.completedAt = Date.now();

      await dbPutJson(redis, "game:" + tr.from, senderState);
      await dbPutJson(redis, "game:" + me, myState);
      await dbPutJson(redis, "trade:" + tradeId, tr);

      return res.status(200).json({ ok: true, message: "トレードが成立しました！", state: myState });
    }

    if (action === "trade_cancel") {
      const tradeId = String(body.tradeId || "").trim();
      const tr = await dbGetJson(redis, "trade:" + tradeId);
      if (!tr || tr.status !== "open" || tr.from !== me) {
        return res.status(404).json({ error: "キャンセルできるトレードが見つかりません。" });
      }
      tr.status = "cancelled";
      await dbPutJson(redis, "trade:" + tradeId, tr);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Invalid action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
