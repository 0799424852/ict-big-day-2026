export const programme = [
 ['arrival','08:00','09:00','Arrival, registration and exhibition viewing','Networking','Registration and organising team','Check in, explore student work and meet potential collaborators.'],
 ['opening','09:00','09:05','Opening and introduction','Ceremony','Dr Phumzile Mseteka and Ms Zenzele Malale','Understand the programme and how to participate.'],
 ['choir-opening','','','Musical item','Ceremony','UMP Choir','Opening musical performance. Timing to be confirmed.'],
 ['welcome','09:05','09:15','Welcoming address','Talk','MANCO representative','Welcome to the first annual ICT Big Day.'],
 ['purpose','09:15','09:25','Purpose of ICT Big Day and expected outcomes','Talk','Dr Norwell Zhakata · SCMS','Connect the day to innovation, entrepreneurship, industry collaboration and 4IR.'],
 ['keynote','09:25','09:55','ICT, innovation, entrepreneurship and the future of work','Talk','Invited keynote speaker','Explore how ICT can translate ideas into practical opportunities.'],
 ['alumni','09:55','10:20','Alumni industry insights','Talk','Mr Tshepo Ntimane and Mr Sydwell Mazibuko · online','Learn from the career journeys of two former students.'],
 ['business','10:20','10:40','Local business and entrepreneurship insights','Talk','Local business representatives · Mr Thando Kayise, Kayise IT','Explore local business needs and entrepreneurship opportunities.'],
 ['government','10:40','10:50','Digital transformation and ICT opportunities','Talk','Government representative','Identify opportunities for ICT in government and communities.'],
 ['international','10:50','11:05','International 4IR insights','Talk','Mrs Irvah Mkhatshwa · Mlumati TVET College · live from China','Explore innovation and global collaboration.'],
 ['tea','11:05','11:20','Tea, exhibitions and networking','Networking','All participants','Try demonstrations and start a conversation with a student team.'],
 ['panel-one','11:20','12:15','Industry, government, academia and entrepreneurship · Panel 1','Panel','Moderator: Ms Precious Leutle. Panellists: Mr Rivalani Hlangwani, Ms Joy Zungu, Mr Bongani Sibuyi and Mr Elijah Mziyako.','Discuss barriers and opportunities for collaboration. The draft assigns 11:20–12:15 to this row; the complete two-panel block needs confirmation.'],
 ['choir-panel','','','Musical item','Ceremony','UMP Choir','Musical interlude. Timing to be confirmed.'],
 ['panel-two','','','Industry, government, academia and entrepreneurship · Panel 2','Panel','Moderator: Ms Precious Leutle. Panellists: Mr Michael Ramatapa, Ms Sinazo Matyila, Rendani Ramaphosa and Dr Siyasanga Mgoduka.','Discuss student innovation, teaching, ICT operations and enterprise development. Timing to be confirmed.'],
 ['collaboration','12:15','12:25','Call for collaboration and community impact','Collaboration','Ms Confidence Ndlovu · Enactus representative','Record an offer, a need or a community challenge and agree on a follow-up.'],
 ['pitches','12:25','13:15','Student innovation project pitch competition','Showcase','Five selected student teams and judges: Mr C Ndlovu, Ms Issah Ngomane, Ms Duduzile Masuku and Dr Bonga Nomvete.','Demonstrate student solutions and identify support for their next stage.'],
 ['lunch','13:15','14:00','Networking lunch and exhibitions','Networking','All participants · judges’ deliberations','Connect with project teams, mentors and partners.'],
 ['abstract-awards','14:00','14:15','Remarks and announcement of abstract winners','Ceremony','Prof Wayi Mgwebi, Dr Hope Mauwa, Dr Norwell Zhakata, Dr Phumzile Mseteka, Dr Yves Semegni, Dr Pardon Maoneke and Dr Motselisi Chere.','Recognise the two best abstracts. Award categories and announcement order to be confirmed.'],
 ['awards','14:15','14:25','Appreciation, certificates and project awards','Ceremony','Executive team · Vuyo Ntshingane and Dimpo Nyaloko','Recognise panellists, guest speakers and project winners. Final award categories to be confirmed.'],
 ['closing','14:25','14:35','Vote of thanks and official closing','Ceremony','Mr MA Makome · organising committee','Reflect on the day and confirm the next steps for collaboration.'],
 ['photo','14:35','14:50','Official group photograph','Ceremony','Guests, winners, staff and participants','Capture the first annual ICT Big Day.'],
 ['departure','14:50','15:00','Departure','Ceremony','All participants','Travel safely and stay connected.'],
] as const;
export const defaults: Record<string,string> = {
 event_title:'ICT Big Day 2026',date:'2026-10-23',venue:'New Great Hall',start:'08:00',end:'15:00',
 theme:'ICT Innovation, Entrepreneurship, Industry Collaboration and the Fourth Industrial Revolution',
 stream_url:'',announcement:'Welcome to the first annual ICT Big Day. Complete your profile and start exploring the programme.',stage:'upcoming',judging_open:'false',reviewing_open:'false',abstracts_open:'true',projects_open:'true',
};
export const categories=['AI and data','Software and apps','IoT and robotics','Cybersecurity','Digital inclusion','Other'];
export const rubric=[['relevance','Problem relevance'],['innovation','Innovation'],['feasibility','Technical feasibility'],['business','Business potential'],['impact','Community impact']] as const;

export const abstractRubric=[['relevance','Relevance to ICT Big Day'],['originality','Originality'],['clarity','Clarity'],['rigour','Method and evidence'],['impact','Potential impact']] as const;
