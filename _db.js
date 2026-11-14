import { Redis } from "@upstash/redis";

let redisClient = null;

export function getRedis() {
  if (redisClient) return redisClient;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  redisClient = new Redis({ url, token });
  return redisClient;
}

export async function dbGetJson(redis, key) {
  const val = await redis.get(key);
  if (val === null || val === undefined) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

export async function dbPutJson(redis, key, obj) {
  await redis.set(key, JSON.stringify(obj));
}

export async function dbDelete(redis, key) {
  await redis.del(key);
}

export async function dbListKeys(redis, prefix) {
  const keys = await redis.keys(prefix + "*");
  return Array.isArray(keys) ? keys : [];
}

export function checkAdmin(key) {
  const clean = String(key || "").replace(/[×x]/g, "*").replace(/\s/g, "");
  return clean === "115638" || clean === "114514+810+314";
}

export async function verifyUser(redis, id, password) {
  if (id === "admin" && checkAdmin(password)) {
    return { id: "admin", status: "approved" };
  }
  const user = await dbGetJson(redis, "user:" + id);
  if (!user || user.password !== password) return null;
  if (user.status !== "approved") return null;
  return user;
}
