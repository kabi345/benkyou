import { getRedis, dbGetJson, dbPutJson, dbDelete, dbListKeys, verifyUser } from "./_db.js";

function dmKey(a, b) {
  const sorted = [String(a), String(b)].sort();
  return "dm:" + sorted[0] + ":" + sorted[1];
}

async function getApprovedPartners(redis, me) {
  const partners = new Set();
  if (me !== "admin") partners.add("admin");
  const keys = await dbListKeys(redis, "user:");
  for (const k of keys) {
    const u = await dbGetJson(redis, k);
    if (u && u.status === "approved" && u.id && u.id !== me) {
      partners.add(u.id);
    }
  }
  return Array.from(partners);
}

async function getUserGroups(redis, me) {
  const groups = [];
  const keys = await dbListKeys(redis, "group:");
  for (const k of keys) {
    const g = await dbGetJson(redis, k);
    if (g && Array.isArray(g.members) && (g.members.includes(me) || me === "admin")) {
      groups.push({
        id: g.id,
        name: g.name,
        owner: g.owner,
        members: g.members
      });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return groups;
}

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({ error: "データベース(Upstash Redis)が接続されていません。" });
  }

  if (req.method === "GET") {
    const me = String(req.query?.me || "").trim();
    const password = String(req.query?.password || "").trim();
    const peer = String(req.query?.peer || "").trim();
    const groupId = String(req.query?.groupId || "").trim();

    const auth = await verifyUser(redis, me, password);
    if (!auth) {
      return res.status(403).json({ error: "認証に失敗しました。" });
    }

    const partners = await getApprovedPartners(redis, me);
    const groups = await getUserGroups(redis, me);

    if (groupId) {
      const g = await dbGetJson(redis, "group:" + groupId);
      if (!g || (!g.members.includes(me) && me !== "admin")) {
        return res.status(403).json({ error: "このグループへのアクセス権がありません。" });
      }
      const messages = (await dbGetJson(redis, "groupmsg:" + groupId)) || [];
      return res.status(200).json({
        ok: true,
        partners,
        groups,
        group: g,
        messages: messages.slice(-100)
      });
    }

    let messages = [];
    if (peer) {
      messages = (await dbGetJson(redis, dmKey(me, peer))) || [];
    }

    return res.status(200).json({
      ok: true,
      partners,
      groups,
      messages: messages.slice(-100)
    });
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const me = String(body.me || "").trim();
    const password = String(body.password || "").trim();
    const action = String(body.action || "send").trim();

    const auth = await verifyUser(redis, me, password);
    if (!auth) {
      return res.status(403).json({ error: "認証に失敗しました。" });
    }

    if (action === "create_group") {
      const name = String(body.name || "").trim().slice(0, 30);
      const rawMembers = Array.isArray(body.members) ? body.members : [];
      if (!name) {
        return res.status(400).json({ error: "グループ名を入力してください。" });
      }

      const memberSet = new Set([me]);
      for (const m of rawMembers) {
        const mid = String(m || "").trim();
        if (!mid) continue;
        if (mid === "admin") {
          memberSet.add("admin");
        } else {
          const u = await dbGetJson(redis, "user:" + mid);
          if (u && u.status === "approved") {
            memberSet.add(mid);
          }
        }
      }

      const groupId = "grp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
      const groupObj = {
        id: groupId,
        name,
        owner: me,
        members: Array.from(memberSet),
        createdAt: Date.now()
      };

      await dbPutJson(redis, "group:" + groupId, groupObj);
      await dbPutJson(redis, "groupmsg:" + groupId, [
        { from: "SYSTEM", text: `${me} がグループ「${name}」を作成しました`, at: Date.now() }
      ]);

      const groups = await getUserGroups(redis, me);
      return res.status(200).json({ ok: true, group: groupObj, groups });
    }

    if (action === "add_member") {
      const groupId = String(body.groupId || "").trim();
      const newMember = String(body.memberId || "").trim();
      const g = await dbGetJson(redis, "group:" + groupId);
      if (!g || (!g.members.includes(me) && me !== "admin")) {
        return res.status(403).json({ error: "グループが見つからないか権限がありません。" });
      }
      if (!newMember) {
        return res.status(400).json({ error: "追加するIDを入力してください。" });
      }
      if (newMember !== "admin") {
        const u = await dbGetJson(redis, "user:" + newMember);
        if (!u || u.status !== "approved") {
          return res.status(404).json({ error: "そのIDは存在しないか、まだ承認されていません。" });
        }
      }
      if (!g.members.includes(newMember)) {
        g.members.push(newMember);
        await dbPutJson(redis, "group:" + groupId, g);
        const msgs = (await dbGetJson(redis, "groupmsg:" + groupId)) || [];
        msgs.push({ from: "SYSTEM", text: `${me} が ${newMember} をグループに追加しました`, at: Date.now() });
        await dbPutJson(redis, "groupmsg:" + groupId, msgs.slice(-150));
      }
      const messages = (await dbGetJson(redis, "groupmsg:" + groupId)) || [];
      return res.status(200).json({ ok: true, group: g, messages: messages.slice(-100) });
    }

    if (action === "leave_group") {
      const groupId = String(body.groupId || "").trim();
      const g = await dbGetJson(redis, "group:" + groupId);
      if (!g || !g.members.includes(me)) {
        return res.status(400).json({ error: "グループに参加していません。" });
      }
      g.members = g.members.filter(m => m !== me);
      if (g.members.length === 0) {
        await dbDelete(redis, "group:" + groupId);
        await dbDelete(redis, "groupmsg:" + groupId);
      } else {
        await dbPutJson(redis, "group:" + groupId, g);
        const msgs = (await dbGetJson(redis, "groupmsg:" + groupId)) || [];
        msgs.push({ from: "SYSTEM", text: `${me} がグループから退出しました`, at: Date.now() });
        await dbPutJson(redis, "groupmsg:" + groupId, msgs.slice(-150));
      }
      const groups = await getUserGroups(redis, me);
      return res.status(200).json({ ok: true, groups });
    }

    const text = String(body.text || "").trim().slice(0, 1000);
    if (!text) {
      return res.status(400).json({ error: "メッセージを入力してください。" });
    }

    const groupId = String(body.groupId || "").trim();
    if (groupId) {
      const g = await dbGetJson(redis, "group:" + groupId);
      if (!g || (!g.members.includes(me) && me !== "admin")) {
        return res.status(403).json({ error: "このグループに送信する権限がありません。" });
      }
      const key = "groupmsg:" + groupId;
      const msgs = (await dbGetJson(redis, key)) || [];
      msgs.push({ from: me, text, at: Date.now() });
      const trimmed = msgs.slice(-150);
      await dbPutJson(redis, key, trimmed);
      return res.status(200).json({ ok: true, messages: trimmed.slice(-100) });
    }

    const peer = String(body.peer || "").trim();
    if (!peer) {
      return res.status(400).json({ error: "送信先が指定されていません。" });
    }
    if (peer !== "admin") {
      const peerUser = await dbGetJson(redis, "user:" + peer);
      if (!peerUser || peerUser.status !== "approved") {
        return res.status(404).json({ error: "送信先のIDが見つからないか、まだ許可されていません。" });
      }
    }

    const key = dmKey(me, peer);
    const msgs = (await dbGetJson(redis, key)) || [];
    msgs.push({ from: me, text, at: Date.now() });
    const trimmed = msgs.slice(-150);
    await dbPutJson(redis, key, trimmed);

    return res.status(200).json({ ok: true, messages: trimmed.slice(-100) });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
