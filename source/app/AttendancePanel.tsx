'use client';
import {Users,CheckCircle2,MapPin,Video,ArrowRight,Radio,RefreshCw,Check} from 'lucide-react';
import type {PlatformState} from './lib/types';
export type CounterStatus='connecting'|'live'|'reconnecting';
export default function AttendancePanel({stats,status,updatedAt,registered,onRegister,onOpen,large=false}:{stats:PlatformState['stats'];status:CounterStatus;updatedAt:string|null;registered:boolean;onRegister:()=>void;onOpen?:()=>void;large?:boolean}){
 const time=updatedAt?new Date(updatedAt).toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Africa/Johannesburg'}):null;
 return <section className={'attendance-panel '+(large?'attendance-large':'attendance-compact')} aria-label="Live registration and attendance counter">
  <div className="attendance-heading"><div><p className="eyebrow">OUR ICT BIG DAY COMMUNITY</p><h2>Make your participation count<span className="gold">.</span></h2><p>Complete your registration and become part of the day.</p></div><span className={'counter-status '+status}>{status==='live'?<span className="counter-dot"/>:<RefreshCw size={12} className={status==='connecting'?'spin':''}/>} {status==='live'?'LIVE COUNTER':status==='connecting'?'CONNECTING':'RECONNECTING'}</span></div>
  <div className="attendance-counts" aria-live="polite" aria-atomic="true">
   <div className="count-featured"><span className="count-icon"><Users size={21}/></span><div><strong>{String(stats.registered).padStart(2,'0')}</strong><span>Registered participants</span></div></div>
   <div className="count-confirmed"><span className="count-icon"><CheckCircle2 size={21}/></span><div><strong>{String(stats.checkedIn).padStart(2,'0')}</strong><span>Confirmed attendance</span></div></div>
   <div className="count-breakdown"><div><MapPin size={15}/><span>Registered in person</span><strong>{stats.inPerson}</strong></div><div><Video size={15}/><span>Registered online</span><strong>{stats.online}</strong></div></div>
  </div>
  <div className="attendance-footer"><div><p>One completed registration per email address. Attendance is confirmed at check-in.</p><small>{status==='reconnecting'?'Connection interrupted. Showing the last saved count.':time?'Updated '+time+' SAST · refreshes every 5 seconds':'Connecting to the live registration count…'}</small></div><div className="button-row">{onOpen&&<button className="text-button" onClick={onOpen}>Open live counter<ArrowRight size={15}/></button>}<button className={'button '+(registered?'secondary':'primary')} onClick={onRegister}>{registered?<><Check size={16}/>You are counted</>:<>Register to be counted<ArrowRight size={16}/></>}</button></div></div>
 </section>;
}
