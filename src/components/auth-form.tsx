"use client";
import { useActionState } from "react";
import Link from "next/link";
import { login,signup,forgotPassword,resetPassword,resendVerification } from "@/app/auth/actions";
import type { AuthState } from "@/domain/auth";
export type AuthMode="login"|"signup"|"forgot-password"|"reset-password"|"verify-email";
const actions={login,signup,"forgot-password":forgotPassword,"reset-password":resetPassword,"verify-email":resendVerification};
const labels={login:"Sign in to your academy",signup:"Create your account","forgot-password":"Send reset link","reset-password":"Save new password","verify-email":"Resend verification email"};
export function AuthForm({mode,configured}:{mode:AuthMode;configured:boolean}){
 const [state,action,pending]=useActionState<AuthState,FormData>(actions[mode],{});
 const password=mode==="login"||mode==="signup"||mode==="reset-password";
 return <form action={action}>
 {state.error&&<div className="notice error" role="alert">{state.error}</div>}
 {state.message&&<div className="notice" role="status">{state.message}</div>}
 {mode==="signup"&&<div className="field"><label htmlFor="displayName">Your name</label><input id="displayName" name="displayName" autoComplete="name" maxLength={100} required disabled={!configured}/></div>}
 {mode!=="reset-password"&&<div className="field"><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" maxLength={254} required disabled={!configured}/></div>}
 {password&&<div className="field"><div className="field-label"><label htmlFor="password">{mode==="reset-password"?"New password":"Password"}</label>{mode==="login"&&<Link href="/forgot-password">Forgot password?</Link>}</div><input id="password" name="password" type="password" autoComplete={mode==="login"?"current-password":"new-password"} minLength={mode==="login"?1:12} maxLength={128} required disabled={!configured}/>{mode!=="login"&&<small className="muted">Use at least 12 characters.</small>}</div>}
 {mode==="reset-password"&&<div className="field"><label htmlFor="confirmPassword">Confirm new password</label><input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={!configured}/></div>}
 <button className="button full" type="submit" disabled={!configured||pending}>{pending?"Please wait…":labels[mode]} <span aria-hidden="true">→</span></button>
 </form>;
}
