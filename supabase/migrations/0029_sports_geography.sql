-- Phase 6 (a): sports reference table, Lebanon geography (governorate → district → town),
-- club location fields, staff "add town" with duplicate protection.
-- Reads: authenticated only. Writes: admin via RLS; staff only through add_town().

-- Sports -----------------------------------------------------------------------
create table sports (
  code       sport primary key,
  name_en    text not null,
  name_ar    text not null,
  sort_order int  not null,
  active     boolean not null default true
);
insert into sports (code, name_en, name_ar, sort_order) values
  ('football',   'Football',   'كرة القدم',    10),
  ('basketball', 'Basketball', 'كرة السلة',    20),
  ('volleyball', 'Volleyball', 'الكرة الطائرة', 30),
  ('padel',      'Padel',      'بادل',         40),
  ('tennis',     'Tennis',     'تنس',          50),
  ('squash',     'Squash',     'سكواش',        60),
  ('other',      'Other',      'أخرى',         90);

-- Geography --------------------------------------------------------------------
create table governorates (
  code             text primary key,
  name_en          text not null,
  name_ar          text not null,
  legacy_parent    text references governorates(code),  -- pre-2017 governorate (8-governorate datasets)
  sort_order       int not null
);
create table districts (
  code             text primary key,
  governorate_code text not null references governorates(code),
  name_en          text not null,
  name_ar          text not null,
  sort_order       int not null
);
create table towns (
  id             uuid primary key default gen_random_uuid(),
  district_code  text not null references districts(code),
  name_en        text not null check (length(trim(name_en)) between 2 and 60),
  name_ar        text check (name_ar is null or length(trim(name_ar)) between 2 and 60),
  lat            numeric(9,6) check (lat between 33 and 35),
  lng            numeric(9,6) check (lng between 35 and 37),
  seeded         boolean not null default true,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);
create unique index towns_unique_name_per_district on towns (district_code, lower(trim(name_en)));
create index towns_district_idx on towns (district_code, name_en);

insert into governorates (code, name_en, name_ar, legacy_parent, sort_order) values
  ('beirut',         'Beirut',          'بيروت',          null,            10),
  ('mount-lebanon',  'Mount Lebanon',   'جبل لبنان',      null,            20),
  ('keserwan-jbeil', 'Keserwan–Jbeil',  'كسروان - جبيل',  'mount-lebanon', 30),
  ('north',          'North',           'الشمال',         null,            40),
  ('akkar',          'Akkar',           'عكار',           null,            50),
  ('beqaa',          'Beqaa',           'البقاع',         null,            60),
  ('baalbek-hermel', 'Baalbek–Hermel',  'بعلبك - الهرمل', null,            70),
  ('south',          'South',           'الجنوب',         null,            80),
  ('nabatieh',       'Nabatieh',        'النبطية',        null,            90);

insert into districts (code, governorate_code, name_en, name_ar, sort_order) values
  ('beirut',          'beirut',         'Beirut',           'بيروت',          10),
  ('baabda',          'mount-lebanon',  'Baabda',           'بعبدا',          10),
  ('aley',            'mount-lebanon',  'Aley',             'عاليه',          20),
  ('chouf',           'mount-lebanon',  'Chouf',            'الشوف',          30),
  ('matn',            'mount-lebanon',  'Matn',             'المتن',          40),
  ('keserwan',        'keserwan-jbeil', 'Keserwan',         'كسروان',         10),
  ('jbeil',           'keserwan-jbeil', 'Jbeil',            'جبيل',           20),
  ('tripoli',         'north',          'Tripoli',          'طرابلس',         10),
  ('koura',           'north',          'Koura',            'الكورة',         20),
  ('zgharta',         'north',          'Zgharta',          'زغرتا',          30),
  ('bsharri',         'north',          'Bsharri',          'بشري',           40),
  ('batroun',         'north',          'Batroun',          'البترون',        50),
  ('minieh-danniyeh', 'north',          'Minieh–Danniyeh',  'المنية - الضنية', 60),
  ('akkar',           'akkar',          'Akkar',            'عكار',           10),
  ('zahle',           'beqaa',          'Zahle',            'زحلة',           10),
  ('western-beqaa',   'beqaa',          'Western Beqaa',    'البقاع الغربي',  20),
  ('rashaya',         'beqaa',          'Rashaya',          'راشيا',          30),
  ('baalbek',         'baalbek-hermel', 'Baalbek',          'بعلبك',          10),
  ('hermel',          'baalbek-hermel', 'Hermel',           'الهرمل',         20),
  ('sidon',           'south',          'Sidon',            'صيدا',           10),
  ('tyre',            'south',          'Tyre',             'صور',            20),
  ('jezzine',         'south',          'Jezzine',          'جزين',           30),
  ('nabatieh',        'nabatieh',       'Nabatieh',         'النبطية',        10),
  ('hasbaya',         'nabatieh',       'Hasbaya',          'حاصبيا',         20),
  ('marjeyoun',       'nabatieh',       'Marjeyoun',        'مرجعيون',        30),
  ('bint-jbeil',      'nabatieh',       'Bint Jbeil',       'بنت جبيل',       40);

-- Main towns per district (not every village; staff add missing ones via add_town)
insert into towns (district_code, name_en, name_ar) values
  ('beirut','Beirut','بيروت'),('beirut','Achrafieh','الأشرفية'),('beirut','Hamra','الحمرا'),('beirut','Ras Beirut','رأس بيروت'),('beirut','Mar Mikhael','مار مخايل'),('beirut','Badaro','بدارو'),('beirut','Verdun','فردان'),('beirut','Mazraa','المزرعة'),('beirut','Gemmayzeh','الجميزة'),('beirut','Ain el-Mreisseh','عين المريسة'),
  ('baabda','Baabda','بعبدا'),('baabda','Hazmieh','الحازمية'),('baabda','Hadath','الحدث'),('baabda','Furn el-Chebbak','فرن الشباك'),('baabda','Chiyah','الشياح'),('baabda','Kfarshima','كفرشيما'),('baabda','Jamhour','الجمهور'),('baabda','Yarze','اليرزة'),('baabda','Bourj el-Barajneh','برج البراجنة'),('baabda','Haret Hreik','حارة حريك'),('baabda','Ghobeiry','الغبيري'),('baabda','Wadi Chahrour','وادي شحرور'),('baabda','Hammana','حمانا'),('baabda','Falougha','فالوغا'),('baabda','Qornayel','قرنايل'),('baabda','Louaizeh','اللويزة'),
  ('aley','Aley','عاليه'),('aley','Bhamdoun','بحمدون'),('aley','Souk el-Gharb','سوق الغرب'),('aley','Choueifat','الشويفات'),('aley','Aramoun','عرمون'),('aley','Bchamoun','بشامون'),('aley','Kahale','الكحالة'),('aley','Ain Dara','عين دارة'),('aley','Chemlan','شملان'),('aley','Aitat','عيتات'),('aley','Khalde','خلدة'),('aley','Dawhet el-Hoss','دوحة الحص'),
  ('chouf','Beiteddine','بيت الدين'),('chouf','Deir el-Qamar','دير القمر'),('chouf','Baakline','بعقلين'),('chouf','Damour','الدامور'),('chouf','Barja','برجا'),('chouf','Chhim','شحيم'),('chouf','Jiyeh','الجية'),('chouf','Moukhtara','المختارة'),('chouf','Barouk','الباروك'),('chouf','Kfarhim','كفرحيم'),('chouf','Maasser el-Chouf','معاصر الشوف'),('chouf','Naameh','الناعمة'),('chouf','Rmeileh','الرميلة'),('chouf','Semqaniyeh','السمقانية'),
  ('matn','Jdeideh','الجديدة'),('matn','Sin el-Fil','سن الفيل'),('matn','Dekwaneh','الدكوانة'),('matn','Bourj Hammoud','برج حمود'),('matn','Antelias','أنطلياس'),('matn','Dbayeh','ضبية'),('matn','Jal el-Dib','جل الديب'),('matn','Zalka','الزلقا'),('matn','Mansourieh','المنصورية'),('matn','Broummana','برمانا'),('matn','Beit Mery','بيت مري'),('matn','Bikfaya','بكفيا'),('matn','Baabdat','بعبدات'),('matn','Rabieh','الرابية'),('matn','Mtaileb','المطيلب'),('matn','Fanar','الفنار'),('matn','Ain Saadeh','عين سعادة'),('matn','Dhour el-Choueir','ضهور الشوير'),('matn','Naccache','النقاش'),('matn','Mazraat Yachouh','مزرعة يشوع'),('matn','Bteghrine','بتغرين'),('matn','Roumieh','رومية'),
  ('keserwan','Jounieh','جونية'),('keserwan','Kaslik','الكسليك'),('keserwan','Zouk Mikael','ذوق مكايل'),('keserwan','Zouk Mosbeh','ذوق مصبح'),('keserwan','Adma','أدما'),('keserwan','Ghazir','غزير'),('keserwan','Sahel Alma','ساحل علما'),('keserwan','Ajaltoun','عجلتون'),('keserwan','Faraya','فاريا'),('keserwan','Kfardebian','كفردبيان'),('keserwan','Harissa','حريصا'),('keserwan','Jeita','جعيتا'),('keserwan','Ballouneh','بلونة'),('keserwan','Safra','الصفرا'),('keserwan','Tabarja','طبرجا'),('keserwan','Bouar','البوار'),('keserwan','Ghosta','غوسطا'),('keserwan','Daraoun','درعون'),('keserwan','Sarba','صربا'),
  ('jbeil','Jbeil (Byblos)','جبيل'),('jbeil','Amchit','عمشيت'),('jbeil','Halat','حالات'),('jbeil','Fidar','الفيدار'),('jbeil','Qartaba','قرطبا'),('jbeil','Annaya','عنايا'),('jbeil','Laqlouq','اللقلوق'),('jbeil','Mastita','مستيتا'),('jbeil','Blat','بلاط'),('jbeil','Edde','إده'),('jbeil','Nahr Ibrahim','نهر إبراهيم'),('jbeil','Jeddayel','جدايل'),
  ('tripoli','Tripoli','طرابلس'),('tripoli','El-Mina','الميناء'),('tripoli','Beddawi','البداوي'),('tripoli','Qalamoun','القلمون'),('tripoli','Abou Samra','أبو سمرا'),('tripoli','Dam w Farz','الضم والفرز'),
  ('koura','Amioun','أميون'),('koura','Chekka','شكا'),('koura','Kousba','كوسبا'),('koura','Enfeh','أنفه'),('koura','Bterram','بترام'),('koura','Kfarhazir','كفرحزير'),('koura','Ras Maska','رأس مسقا'),('koura','Deddeh','ددة'),('koura','Kfaraakka','كفرعقا'),('koura','Fih','فيع'),('koura','Bsarma','بصرما'),('koura','Kelhat','كلحات'),('koura','Btouratij','بطرماز'),('koura','Kfarsaroun','كفرصارون'),
  ('zgharta','Zgharta','زغرتا'),('zgharta','Ehden','إهدن'),('zgharta','Mejdlaya','مجدليا'),('zgharta','Ardeh','أرده'),('zgharta','Rachiine','رشعين'),('zgharta','Kfarhata','كفرحاتا'),('zgharta','Miryata','مرياطة'),('zgharta','Aslout','أسلوت'),('zgharta','Kfarzeina','كفرزينا'),
  ('bsharri','Bsharri','بشري'),('bsharri','Hadath el-Jebbeh','حدث الجبة'),('bsharri','Hasroun','حصرون'),('bsharri','Bqaa Kafra','بقاعكفرا'),('bsharri','Qnat','قنات'),('bsharri','Bazoun','بزعون'),('bsharri','Hadchit','حدشيت'),('bsharri','Bqarqacha','بقرقاشا'),
  ('batroun','Batroun','البترون'),('batroun','Tannourine','تنورين'),('batroun','Douma','دوما'),('batroun','Kfarabida','كفرعبيدا'),('batroun','Kfifane','كفيفان'),('batroun','Hamat','حامات'),('batroun','Selaata','سلعاتا'),('batroun','Kour','كور'),('batroun','Rachkida','راشكيدا'),('batroun','Thoum','ثوم'),('batroun','Kfarhelda','كفرحلدا'),('batroun','Assia','عصيا'),('batroun','Jran','جران'),('batroun','Chebtine','شبطين'),('batroun','Bchaaleh','بشعلة'),('batroun','Ijdabra','إجدبرا'),('batroun','Kfour el-Arabi','كفور العربي'),
  ('minieh-danniyeh','Minieh','المنية'),('minieh-danniyeh','Sir el-Danniyeh','سير الضنية'),('minieh-danniyeh','Bakhoun','بخعون'),('minieh-danniyeh','Deir Ammar','دير عمار'),('minieh-danniyeh','Bqaa Safrin','بقاعصفرين'),('minieh-danniyeh','Beit el-Faqs','بيت الفقس'),('minieh-danniyeh','Kfarhabou','كفرحبو'),('minieh-danniyeh','Markabta','مركبتا'),('minieh-danniyeh','Nabi Youchaa','النبي يوشع'),
  ('akkar','Halba','حلبا'),('akkar','Qoubaiyat','القبيات'),('akkar','Bebnine','ببنين'),('akkar','Minyara','منيارة'),('akkar','Rahbeh','رحبة'),('akkar','Akkar el-Atiqa','عكار العتيقة'),('akkar','Bireh','البيرة'),('akkar','Andaket','عندقت'),('akkar','Machta Hassan','مشتى حسن'),('akkar','Berqayel','برقايل'),('akkar','Sheikh Taba','شيخ طابا'),('akkar','Tal Abbas','تل عباس'),('akkar','Abdeh','العبدة'),('akkar','Mhammara','المحمرة'),('akkar','Bqarzla','بقرزلا'),('akkar','Fnaideq','فنيدق'),('akkar','Michmich','مشمش'),('akkar','Kfartoun','كفرتون'),
  ('zahle','Zahle','زحلة'),('zahle','Chtaura','شتورة'),('zahle','Bar Elias','بر الياس'),('zahle','Jdita','جديتا'),('zahle','Saadnayel','سعدنايل'),('zahle','Taalabaya','تعلبايا'),('zahle','Kab Elias','قب الياس'),('zahle','Riyaq','رياق'),('zahle','Ablah','أبلح'),('zahle','Niha','نيحا'),('zahle','Ferzol','الفرزل'),('zahle','Qaa el-Rim','قاع الريم'),('zahle','Anjar','عنجر'),('zahle','Majdel Anjar','مجدل عنجر'),('zahle','Mekse','مكسة'),('zahle','Haouch el-Oumara','حوش الأمراء'),('zahle','Ksara','كسارا'),('zahle','Terbol','تربل'),
  ('western-beqaa','Joub Jannine','جب جنين'),('western-beqaa','Machghara','مشغرة'),('western-beqaa','Qaraoun','القرعون'),('western-beqaa','Sohmor','سحمر'),('western-beqaa','Kefraya','كفريا'),('western-beqaa','Kamed el-Loz','كامد اللوز'),('western-beqaa','Saghbine','صغبين'),('western-beqaa','Khirbet Qanafar','خربة قنافار'),('western-beqaa','Lala','لالا'),('western-beqaa','Ghazzeh','غزة'),('western-beqaa','Mansoura','المنصورة'),('western-beqaa','Ain Zebde','عين زبدة'),
  ('rashaya','Rashaya','راشيا'),('rashaya','Kfarqouq','كفرقوق'),('rashaya','Aiha','عيحا'),('rashaya','Mdoukha','مضوخا'),('rashaya','Yanta','ينطا'),('rashaya','Ain Ata','عين عطا'),('rashaya','Rafid','الرفيد'),('rashaya','Kfarmechki','كفرمشكي'),('rashaya','Deir el-Aachayer','دير العشاير'),
  ('baalbek','Baalbek','بعلبك'),('baalbek','Douris','دورس'),('baalbek','Chmistar','شمسطار'),('baalbek','Britel','بريتال'),('baalbek','Ain Bourday','عين بورضاي'),('baalbek','Deir el-Ahmar','دير الأحمر'),('baalbek','Nabi Chit','النبي شيت'),('baalbek','Laboueh','اللبوة'),('baalbek','Ras Baalbek','رأس بعلبك'),('baalbek','Qaa','القاع'),('baalbek','Arsal','عرسال'),('baalbek','Fakeha','الفاكهة'),('baalbek','Temnine','تمنين'),('baalbek','Talya','طليا'),('baalbek','Bednayel','بدنايل'),('baalbek','Younine','يونين'),('baalbek','Iaat','إيعات'),('baalbek','Hadath Baalbek','حدث بعلبك'),
  ('hermel','Hermel','الهرمل'),('hermel','Qasr','القصر'),('hermel','Fissane','فيسان'),('hermel','Kouakh','كواخ'),
  ('sidon','Sidon (Saida)','صيدا'),('sidon','Abra','عبرا'),('sidon','Haret Saida','حارة صيدا'),('sidon','Ghazieh','الغازية'),('sidon','Bramieh','البرامية'),('sidon','Majdelyoun','مجدليون'),('sidon','Anqoun','عنقون'),('sidon','Zahrani','الزهراني'),('sidon','Sarafand','الصرفند'),('sidon','Adloun','عدلون'),('sidon','Maghdouche','مغدوشة'),('sidon','Hlaliyeh','الهلالية'),('sidon','Salhieh','الصالحية'),('sidon','Darb el-Sim','درب السيم'),('sidon','Ain el-Delb','عين الدلب'),
  ('tyre','Tyre (Sour)','صور'),('tyre','Abbasiyeh','العباسية'),('tyre','Borj el-Chemali','برج الشمالي'),('tyre','Qana','قانا'),('tyre','Bazourieh','البازورية'),('tyre','Maarakeh','معركة'),('tyre','Jouaiya','جويا'),('tyre','Srifa','صريفا'),('tyre','Deir Qanoun el-Nahr','دير قانون النهر'),('tyre','Naqoura','الناقورة'),('tyre','Ain Baal','عين بعال'),('tyre','Tayr Debba','طير دبا'),('tyre','Qlaileh','القليلة'),('tyre','Toura','طورا'),('tyre','Jebbayn','جبين'),('tyre','Chehabiyeh','الشهابية'),
  ('jezzine','Jezzine','جزين'),('jezzine','Kfarhouneh','كفرحونة'),('jezzine','Bkassine','بكاسين'),('jezzine','Roum','روم'),('jezzine','Machmouche','مشموشة'),('jezzine','Lebaa','لبعا'),('jezzine','Aazour','عازور'),('jezzine','Kfarfalous','كفرفالوس'),('jezzine','Qaytouli','قيتولي'),('jezzine','Sfaray','صفاري'),
  ('nabatieh','Nabatieh','النبطية'),('nabatieh','Kfar Remmane','كفررمان'),('nabatieh','Doueir','الدوير'),('nabatieh','Habbouch','حبوش'),('nabatieh','Jbaa','جباع'),('nabatieh','Arabsalim','عربصاليم'),('nabatieh','Zawtar','زوطر'),('nabatieh','Kfar Tebnit','كفرتبنيت'),('nabatieh','Harouf','حاروف'),('nabatieh','Zefta','زفتا'),('nabatieh','Kfour','الكفور'),('nabatieh','Ansar','أنصار'),('nabatieh','Zebdine','زبدين'),('nabatieh','Mayfadoun','ميفدون'),('nabatieh','Yohmor','يحمر'),('nabatieh','Sharqiyeh','الشرقية'),('nabatieh','Kfarsir','كفرصير'),
  ('hasbaya','Hasbaya','حاصبيا'),('hasbaya','Chebaa','شبعا'),('hasbaya','Kfarchouba','كفرشوبا'),('hasbaya','Mimess','ميمس'),('hasbaya','Kawkaba','كوكبا'),('hasbaya','Khalwat','الخلوات'),('hasbaya','Rachaya el-Foukhar','راشيا الفخار'),('hasbaya','Ain Qenia','عين قنيا'),('hasbaya','Hebbariyeh','الهبارية'),
  ('marjeyoun','Marjeyoun','مرجعيون'),('marjeyoun','Khiam','الخيام'),('marjeyoun','Kfar Kila','كفركلا'),('marjeyoun','Deir Mimas','دير ميماس'),('marjeyoun','Qlayaa','القليعة'),('marjeyoun','Jdeidet Marjeyoun','جديدة مرجعيون'),('marjeyoun','Burj el-Mulouk','برج الملوك'),('marjeyoun','Debbine','دبين'),('marjeyoun','Ibl el-Saqi','إبل السقي'),('marjeyoun','Houla','حولا'),('marjeyoun','Mays el-Jabal','ميس الجبل'),('marjeyoun','Taybeh','الطيبة'),('marjeyoun','Adaisseh','العديسة'),('marjeyoun','Markaba','مركبا'),
  ('bint-jbeil','Bint Jbeil','بنت جبيل'),('bint-jbeil','Tebnine','تبنين'),('bint-jbeil','Ain Ebel','عين إبل'),('bint-jbeil','Rmeich','رميش'),('bint-jbeil','Aitaroun','عيترون'),('bint-jbeil','Maroun el-Ras','مارون الراس'),('bint-jbeil','Kounine','كونين'),('bint-jbeil','Yater','ياطر'),('bint-jbeil','Beit Lif','بيت ليف'),('bint-jbeil','Debel','دبل'),('bint-jbeil','Shaqra','شقرا'),('bint-jbeil','Haris','حاريص'),('bint-jbeil','Kafra','كفرا'),('bint-jbeil','Srobbine','صربين'),('bint-jbeil','Aita el-Chaab','عيتا الشعب'),('bint-jbeil','Khirbet Selem','خربة سلم'),('bint-jbeil','Qaouzah','القوزح'),('bint-jbeil','Chihine','شيحين');

-- RLS: read for signed-in users; admin may maintain; staff add towns via RPC only
alter table sports enable row level security;
alter table governorates enable row level security;
alter table districts enable row level security;
alter table towns enable row level security;
create policy "sports: read" on sports for select to authenticated using (true);
create policy "governorates: read" on governorates for select to authenticated using (true);
create policy "districts: read" on districts for select to authenticated using (true);
create policy "towns: read" on towns for select to authenticated using (true);
create policy "sports: admin" on sports for all to authenticated using (is_admin()) with check (is_admin());
create policy "governorates: admin" on governorates for all to authenticated using (is_admin()) with check (is_admin());
create policy "districts: admin" on districts for all to authenticated using (is_admin()) with check (is_admin());
create policy "towns: admin" on towns for all to authenticated using (is_admin()) with check (is_admin());
revoke all on sports, governorates, districts, towns from anon;

-- Staff of any club may add a missing town. Duplicate (case-insensitive) → returns the existing id, no new row.
create or replace function add_town(p_district text, p_name_en text, p_name_ar text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text := trim(p_name_en);
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_admin() or exists (select 1 from club_staff where profile_id = auth.uid())) then raise exception 'forbidden'; end if;
  if not exists (select 1 from districts where code = p_district) then raise exception 'bad_district'; end if;
  if length(v_name) < 2 or length(v_name) > 60 then raise exception 'bad_town_name'; end if;
  select id into v_id from towns where district_code = p_district and lower(trim(name_en)) = lower(v_name);
  if v_id is not null then return v_id; end if;
  insert into towns (district_code, name_en, name_ar, seeded, created_by)
  values (p_district, v_name, nullif(trim(p_name_ar), ''), false, auth.uid())
  on conflict (district_code, lower(trim(name_en))) do update set name_en = towns.name_en
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function add_town(text, text, text) from public, anon;
grant execute on function add_town(text, text, text) to authenticated;

-- Area selector: governorates with their districts, one call
create or replace function areas() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', g.code, 'name_en', g.name_en, 'name_ar', g.name_ar,
    'districts', (select coalesce(jsonb_agg(jsonb_build_object('code', d.code, 'name_en', d.name_en, 'name_ar', d.name_ar) order by d.sort_order), '[]'::jsonb)
                  from districts d where d.governorate_code = g.code)
  ) order by g.sort_order), '[]'::jsonb)
  from governorates g where auth.uid() is not null;
$$;
revoke execute on function areas() from public, anon;
grant execute on function areas() to authenticated;

-- Clubs: location ----------------------------------------------------------------
alter table clubs
  add column if not exists town_id   uuid references towns(id),
  add column if not exists lat       numeric(9,6) check (lat is null or lat between 33 and 35),
  add column if not exists lng       numeric(9,6) check (lng is null or lng between 35 and 37),
  add column if not exists cover_url text;
create index if not exists clubs_town_idx on clubs (town_id);

-- demo club
update clubs set town_id = (select id from towns where district_code = 'batroun' and name_en = 'Batroun') where slug = 'batroun' and town_id is null;

-- staff settings: town + coordinates (signature changes → drop old)
drop function if exists update_club_settings(uuid, time, time, int, int, int, int, int, int, text);
create or replace function update_club_settings(
  p_club uuid, p_open time, p_close time, p_slot int, p_min int, p_max int,
  p_cutoff int, p_hold int, p_window int, p_location text,
  p_town uuid default null, p_lat numeric default null, p_lng numeric default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_staff_of(p_club) then raise exception 'forbidden'; end if;
  if p_town is not null and not exists (select 1 from towns where id = p_town) then raise exception 'bad_town'; end if;
  update clubs set open_time = p_open, close_time = p_close, slot_minutes = p_slot,
    min_booking_minutes = p_min, max_booking_minutes = p_max, cancel_cutoff_hours = p_cutoff,
    hold_minutes = p_hold, booking_window_days = p_window, location_url = nullif(p_location, ''),
    town_id = p_town, lat = p_lat, lng = p_lng
  where id = p_club;
end $$;
revoke execute on function update_club_settings(uuid, time, time, int, int, int, int, int, int, text, uuid, numeric, numeric) from public, anon;
grant execute on function update_club_settings(uuid, time, time, int, int, int, int, int, int, text, uuid, numeric, numeric) to authenticated;

-- A club's sports = sports of its active courts (derived, never stored)
create or replace function club_sports(p_club uuid) returns sport[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct c.sport order by c.sport), '{}') from courts c where c.club_id = p_club and c.active;
$$;
revoke execute on function club_sports(uuid) from public, anon;
grant execute on function club_sports(uuid) to authenticated;
