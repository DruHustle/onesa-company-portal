import {randomUUID} from 'node:crypto';
import {seedTemplates} from './workflows.js';
import {db,transaction} from './db.js';
import {synchronizeApprovedCompany} from './company-publication.js';
await transaction(synchronizeApprovedCompany);
await seedTemplates();
for(const [locale,title,summary,body] of [
 ['en','Onesa AI Platform','A modular AI platform for Chat, Knowledge, Agents and Travel.','The sibling repository implements Chat, Knowledge/RAG, Agents and Travel interfaces, configurable open-weight serving and developer API routes. Travel providers are unconfigured. Model customization includes evaluation and dry-run training workflows. Roadmap statements require product-owner approval. Source: sibling repository README inspected 9 October 2026.'],
 ['de','Onesa AI Platform','Eine modulare KI-Plattform für Chat, Knowledge, Agents und Travel.','Das benachbarte Repository implementiert Chat, Knowledge/RAG, Agents und Travel, konfigurierbare Open-Weight-Modelle und API-Routen. Reiseanbieter sind nicht konfiguriert. Modellanpassung umfasst Evaluation und Trainings-Testläufe. Aussagen zur Roadmap bedürfen der Freigabe durch den Produktverantwortlichen. Quelle: README des benachbarten Repositorys, geprüft am 9. Oktober 2026.']
])await transaction(async c=>{const result=await c.query("INSERT INTO content(id,kind,slug,locale,title,summary,body) VALUES($1,'product','onesa-ai-platform',$2,$3,$4,$5) ON CONFLICT(kind,slug,locale) DO NOTHING RETURNING *",[randomUUID(),locale,title,summary,body]);if(result.rows[0])await c.query('INSERT INTO revisions(content_id,snapshot) VALUES($1,$2)',[result.rows[0].id,JSON.stringify(result.rows[0])]);});
await db.end();
