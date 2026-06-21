import { createClient } from "@supabase/supabase-js";

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || "").trim();
const supabaseAnonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

export const isCloudConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const cloudConfigurationMessage = isCloudConfigured
  ? "云端已配置"
  : "云端未配置，当前使用本地模式";

export const supabase = isCloudConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;
