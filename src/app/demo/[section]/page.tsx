import { notFound } from "next/navigation";
import { AcademyShell } from "@/components/academy-shell";
import { DemoSection,demoSections,type DemoSectionName } from "@/components/demo-section";
export default async function Page({params}:{params:Promise<{section:string}>}){const {section}=await params;if(!demoSections.includes(section as DemoSectionName))notFound();return <AcademyShell demo><DemoSection section={section as DemoSectionName}/></AcademyShell>;}
