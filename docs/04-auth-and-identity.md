# Authentication and identity
## Contract
All methods resolve to one Supabase user, then one stable Ducelio app_user. Backend getUser() validates the current session with the auth service; never trust getSession() or client roles. Credentials and provider secrets belong in Supabase configuration, not application code.
Signup stores only a bounded display name in metadata. A database trigger creates a Ducelio identity/profile and STUDENT grant; it ignores client role metadata. Existing Supabase users must be backfilled with the migration's idempotent mapping.
Use Supabase verified-email identity linking. Do not implement application merging by comparing email strings. Automatic linking of verified provider identities is delegated to Supabase; unresolved duplicates need a manual record-preserving institutional workflow. Manual cross-email linking is intentionally not exposed in Phase 1. Magic links are deferred.
## Setup
1. Create a Supabase project; apply migrations in order (see 06). Choose a region and retention policy appropriate to your institution.
2. Copy .env.example to .env.local. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from the project API settings. Set APP_URL to the exact trusted origin. Production requires HTTPS.
3. In Authentication → URL Configuration, set Site URL to APP_URL. Allow exact callback URLs: APP_URL/auth/callback, APP_URL/auth/callback?next=/reset-password and APP_URL/auth/confirm. Avoid wildcard production redirects.
4. Enable email/password and confirm-email requirements. Configure custom SMTP, rate limits, abuse protection/CAPTCHA as appropriate, sender domain and deliverability. Configure minimum password length to at least 12 characters.
5. Confirmation email template: use APP_URL/auth/confirm?token_hash={{ .TokenHash }}&type=email (replace APP_URL with your exact origin). Recovery template: APP_URL/auth/confirm?token_hash={{ .TokenHash }}&type=recovery. Alternatively PKCE code callbacks work in the originating browser.
6. Google Cloud: create OAuth Web application, configure consent screen/test users or publish, and register https://PROJECT_REF.supabase.co/auth/v1/callback as the authorised redirect. Put client ID and secret in Supabase Google provider settings. Then AUTH_GOOGLE_ENABLED=true.
7. LinkedIn Developers: create an application and enable “Sign In with LinkedIn using OpenID Connect”. Register the same Supabase callback, configure client ID/secret under LinkedIn (OIDC), allow openid/profile/email scopes, then AUTH_LINKEDIN_ENABLED=true.
8. Exercise registration, confirmation, sign-in/out, expired links, recovery, both OAuth providers and duplicate verified email scenarios on staging. Real SMTP/provider credentials cannot be validated by credential-free unit tests.
## References
- https://supabase.com/docs/guides/auth/server-side/creating-a-client
- https://supabase.com/docs/guides/auth/auth-identity-linking
- https://supabase.com/docs/guides/auth/social-login/auth-google
- https://supabase.com/docs/guides/auth/social-login/auth-linkedin
- https://nextjs.org/docs/app/getting-started/installation
