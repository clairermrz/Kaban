/* Site configuration — edit these values, then redeploy.
   The Supabase URL and anon/publishable key are meant to be public: they ship to every visitor's
   browser. Your users' data is protected by the Row Level Security policies in supabase/schema.sql,
   not by keeping this key secret. NEVER put the "service_role" / secret key here. */
window.APP_CONFIG = {
  appName: 'Kaban',

  // Supabase → Project Settings → API (or Connect → App Frameworks)
  supabaseUrl: 'https://qmraetewzmyqbhimiptm.supabase.co',
  supabaseAnonKey: 'sb_publishable_mqiTzjN3HZFmRUxkpAB9dg_x94HpnTV'   // the "anon" / "publishable" key

  // Leave both blank to run in local-only mode (data saved in the browser, no accounts).
};
