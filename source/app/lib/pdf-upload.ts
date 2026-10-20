import {AppError} from './core.ts';
export async function readPdfUpload(request:Request,maximum=10*1024*1024){
 if(!request.headers.get('content-type')?.includes('multipart/form-data'))throw new AppError('Choose a PDF document.');
 const reader=request.body?.getReader();if(!reader)throw new AppError('Choose a PDF document.');
 let length=0;const chunks:Uint8Array[]=[];
 while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>maximum+131072){await reader.cancel();throw new AppError('Use a PDF of 10 MB or less.',413);}chunks.push(part.value);}
 const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
 const form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('content-type')!}}).formData();
 if(form.getAll('file').length!==1)throw new AppError('Upload one PDF document at a time.');
 const file=form.get('file');
 if(!file||typeof file==='string'||file.size===0||file.size>maximum)throw new AppError('Use a PDF of 10 MB or less.');
 if(!file.name.toLowerCase().endsWith('.pdf')||new TextDecoder().decode(await file.slice(0,5).arrayBuffer())!=='%PDF-')throw new AppError('Upload a valid PDF document.');
 return file;
}
