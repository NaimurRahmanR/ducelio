import { NextResponse } from "next/server";
import { getCurrentActor } from "@/server/identity";
import { canEnter } from "@/domain/policy";
export async function GET(){const actor=await getCurrentActor();if(!actor)return NextResponse.json({error:"Authentication required"},{status:401});if(!canEnter(actor,"admin"))return NextResponse.json({error:"Access denied"},{status:403});return NextResponse.json({area:"Academy administration",status:"Phase 1 shell"},{headers:{"Cache-Control":"private, no-store"}});}