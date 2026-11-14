import { getRedis, dbGetJson, dbPutJson, dbDelete, dbListKeys, checkAdmin } from "./_db.js";

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({ error: "データベース(Upstash Redis)が接続されていません。VercelのStorageから追加して再デプロイしてください。" });
  }

  const action = String(req.query?.action || "").trim();

  if (req.method === "GET") {
    if (action === "list") {
      const adminKey = req.query?.adminKey;
      if (!checkAdmin(adminKey)) {
        return res.status(403).json({ error: "管理者権限がありません。" });
      }
      const keys = await dbListKeys(redis, "user:");
      const users = [];
      for (const k of keys) {
        const val = await dbGetJson(redis, k);
        if (val) users.push(val);
      }
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json({ users });
    }
    return res.status(400).json({ error: "Invalid action" });
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (action === "register") {
      const id = String(body.id || "").trim();
      const password = String(body.password || "").trim();
      if (!/^[a-zA-Z0-9_-]{2,24}$/.test(id)) {
        return res.status(400).json({ error: "IDは半角英数字・ハイフン・アンダースコアで2〜24文字にしてください。" });
      }
      if (password.length < 3 || password.length > 40) {
        return res.status(400).json({ error: "パスワードは3〜40文字で設定してください。" });
      }
      if (id.toLowerCase() === "admin") {
        return res.status(400).json({ error: "このIDは使用できません。" });
      }
      const existing = await dbGetJson(redis, "user:" + id);
      if (existing) {
        return res.status(409).json({ error: "このIDはすでに使われています。別のIDにしてください。" });
      }
      const userObj = {
        id,
        password,
        status: "pending",
        createdAt: Date.now()
      };
      await dbPutJson(redis, "user:" + id, userObj);
      return res.status(200).json({
        ok: true,
        message: "アカウント申請を送信しました！管理者の許可をお待ちください。",
        status: "pending"
      });
    }

    if (action === "login") {
      const id = String(body.id || "").trim();
      const password = String(body.password || "").trim();
      if (!id || !password) {
        return res.status(400).json({ error: "IDとパスワードを入力してください。" });
      }
      const user = await dbGetJson(redis, "user:" + id);
      if (!user || user.password !== password) {
        return res.status(401).json({ error: "IDまたはパスワードが違います。" });
      }
      return res.status(200).json({
        ok: true,
        id: user.id,
        status: user.status
      });
    }

    if (action === "decide") {
      if (!checkAdmin(body.adminKey)) {
        return res.status(403).json({ error: "管理者権限がありません。" });
      }
      const targetId = String(body.id || "").trim();
      const decision = String(body.decision || "").trim();
      if (!targetId) return res.status(400).json({ error: "対象IDがありません。" });

      if (decision === "delete") {
        await dbDelete(redis, "user:" + targetId);
        return res.status(200).json({ ok: true });
      }

      const user = await dbGetJson(redis, "user:" + targetId);
      if (!user) return res.status(404).json({ error: "ユーザーが見つかりません。" });
      user.status = decision === "approved" ? "approved" : "rejected";
      await dbPutJson(redis, "user:" + targetId, user);
      return res.status(200).json({ ok: true, user });
    }

    return res.status(400).json({ error: "Invalid action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
