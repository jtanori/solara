import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { createSession, hashPassword, hashToken, sameOrigin, SESSION_COOKIE, verifyPassword } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
export async function POST(request:Request) {
  if(!sameOrigin(request)) return NextResponse.json({error:"Invalid request origin."},{status:403});
  const es=(await getLocale())==="es";
  try { const data=await request.json(); const email=typeof data.email==="string"?data.email.trim().toLowerCase():""; const password=typeof data.password==="string"?data.password:""; const name=typeof data.name==="string"?data.name.trim():"";
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||password.length<10||password.length>128) return NextResponse.json({error:es?"Introduce un correo válido y una contraseña de 10 a 128 caracteres.":"Enter a valid email and a password of 10–128 characters."},{status:400});
    let user;
    if(data.mode==="signup") { if(name.length<1||name.length>100) return NextResponse.json({error:es?"Introduce tu nombre.":"Please enter your name."},{status:400}); const existing=await db.select({id:users.id}).from(users).where(eq(users.email,email)).limit(1); if(existing.length) return NextResponse.json({error:es?"Ya existe una cuenta con este correo. Intenta iniciar sesión.":"An account already exists for this email. Try signing in."},{status:409}); [user]=await db.insert(users).values({name,email,passwordHash:hashPassword(password),role:"user",plan:"free"}).returning(); }
    else if(data.mode==="login") { const found=await db.select().from(users).where(eq(users.email,email)).limit(1); if(!found[0]||!verifyPassword(password,found[0].passwordHash)) return NextResponse.json({error:es?"El correo o la contraseña son incorrectos.":"Email or password is incorrect."},{status:401}); user=found[0]; }
    else return NextResponse.json({error:es?"Solicitud no válida.":"Invalid request."},{status:400});
    const session=await createSession(user.id);const response=NextResponse.json({ok:true,name:user.name});response.cookies.set(SESSION_COOKIE,session.token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:session.expiresAt});return response;
  } catch(error) {console.error("Authentication error",error);return NextResponse.json({error:es?"No pudimos completar tu solicitud. Inténtalo de nuevo.":"Unable to complete your request. Please try again."},{status:500});}
}
export async function DELETE(request:Request) {if(!sameOrigin(request)) return NextResponse.json({error:"Invalid request origin."},{status:403});const token=(await cookies()).get(SESSION_COOKIE)?.value;if(token) await db.delete(sessions).where(eq(sessions.tokenHash,hashToken(token)));const response=NextResponse.json({ok:true});response.cookies.set(SESSION_COOKIE,"",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:0});return response;}
