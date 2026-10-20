import {createRoot} from 'react-dom/client';
import Platform,{type View} from './app/Platform';
const views:Record<string,View>={attendee:'participation',participant:'submissions',judge:'judging',reviewer:'reviewing',organiser:'organiser',administrator:'administrator'};
const role=location.pathname.split('/')[2];
createRoot(document.getElementById('root')!).render(<Platform initialView={views[role]||'overview'}/>);
