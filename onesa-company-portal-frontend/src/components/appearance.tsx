'use client';
import {useEffect,useState} from 'react';
type Preference='auto'|'light'|'dark';
declare global {interface Window {OnesaAppearance?:{getPreference:()=>Preference;getMode:()=> 'light'|'dark';setPreference:(value:Preference)=>void;refresh:()=>void}}}
export function Appearance({locale='en'}:{locale?:'en'|'de'}) {
 const [preference,setPreference]=useState<Preference>('auto');
 useEffect(()=>{const update=()=>setPreference(window.OnesaAppearance?.getPreference()||'auto');update();window.addEventListener('onesa:appearance',update);return()=>window.removeEventListener('onesa:appearance',update);},[]);
 return <label className="appearance-control"><span>{locale==='de'?'Darstellung':'Appearance'}</span><select value={preference} title={locale==='de'?'Auto: Hell 07:00–18:59, Dunkel 19:00–06:59 (Ortszeit)':'Auto: light 07:00–18:59, dark 19:00–06:59 (local time)'} onChange={event=>window.OnesaAppearance?.setPreference(event.target.value as Preference)}><option value="auto">Auto</option><option value="light">{locale==='de'?'Hell':'Light'}</option><option value="dark">{locale==='de'?'Dunkel':'Dark'}</option></select></label>;
}
