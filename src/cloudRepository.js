import { supabase } from "./supabaseClient.js";

function requireCloudClient() {
  if (!supabase) throw new Error("云端未配置，当前使用本地模式");
  return supabase;
}

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user || null;
}

export async function ensureProfile(profile = {}) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

  const payload = {
    id: user.id,
    display_name: profile.displayName ?? user.user_metadata?.display_name ?? null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await client
    .from("profiles")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listCloudLibraries() {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await client
    .from("libraries")
    .select("id, owner_id, name, description, visibility, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function uploadLibrarySkeleton(library) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  if (!library || !String(library.name || "").trim()) throw new Error("词库名称不能为空");

  const payload = {
    owner_id: user.id,
    name: String(library.name).trim(),
    description: library.description || null,
    visibility: "private"
  };
  const { data, error } = await client.from("libraries").insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function downloadLibrarySkeleton(libraryId) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  const { data, error } = await client
    .from("libraries")
    .select("id, owner_id, name, description, visibility, created_at, updated_at")
    .eq("id", libraryId)
    .single();
  if (error) throw error;
  return data;
}
