import type { Language } from "./language";

type Names = readonly [en: string, ko: string, zh: string, zhHant: string, fr: string, de: string, es: string, pt: string];
type CatalogRow = readonly [id: string, names: Names, direction: string];

const nameIndex = { en: 0, ko: 1, zh: 2, "zh-Hant": 3, fr: 4, de: 5, es: 6, pt: 7 } as const satisfies Record<Language, number>;
export const studioPresetName = (preset: { names: Names }, lang: Language) => preset.names[nameIndex[lang]];

export const STUDIO_PHOTO_CATEGORIES = ["film", "art", "animation", "miniature", "style", "scene", "design", "playful"] as const;
export type StudioPhotoCategory = (typeof STUDIO_PHOTO_CATEGORIES)[number];
export type StudioPhotoPreset = {
  id: string;
  category: StudioPhotoCategory;
  tool: "illustration" | "caricature" | "transparent-png";
  names: Names;
  artwork: string;
  style?: string;
};

const photoCatalog = {
  film: [
    ["film-70s", ["1970s portrait","1970년대 인물","70年代人像","70 年代人像","Portrait années 1970","Porträt der 1970er","Retrato de los 70","Retrato dos anos 70"], "a warm 1970s analog portrait with vintage knitwear and soft film grain"],
    ["studio-80s", ["1980s studio portrait","1980년대 스튜디오","80年代影棚人像","80 年代棚拍人像","Portrait studio années 80","Studioporträt der 80er","Retrato de estudio de los 80","Retrato de estúdio dos anos 80"], "an 1980s studio portrait with a marbled backdrop, styled hair and soft flash"],
    ["camcorder-90s", ["1990s camcorder","1990년대 캠코더","90年代摄像机","90 年代攝影機","Caméscope années 90","Camcorder der 90er","Videocámara de los 90","Filmadora dos anos 90"], "a candid 1990s camcorder still with gentle scan texture, faded colors and no timecode"],
    ["digicam-y2k", ["Y2K digicam","Y2K 디카","千禧数码相机","千禧數位相機","Compact numérique Y2K","Y2K-Digicam","Cámara digital Y2K","Câmera digital Y2K"], "an early-2000s compact-camera snapshot with cool direct flash and punchy colors"],
    ["instant-photo", ["Instant print","즉석 사진","拍立得","拍立得","Photo instantanée","Sofortbild","Foto instantánea","Foto instantânea"], "an instant-film print with a white frame, analog colors and mild overexposure"],
    ["monochrome", ["Black-and-white portrait","흑백 인물","黑白人像","黑白人像","Portrait noir et blanc","Schwarzweißporträt","Retrato en blanco y negro","Retrato em preto e branco"], "a timeless black-and-white portrait with rich midtones and soft directional light"],
    ["golden-hour", ["Golden hour","골든아워","黄金时刻","黃金時刻","Heure dorée","Goldene Stunde","Hora dorada","Hora dourada"], "a golden-hour portrait with warm side light and softly lit hair edges"],
    ["night-flash", ["Night flash","야간 플래시","夜间闪光","夜間閃光","Flash de nuit","Nachtblitz","Flash nocturno","Flash noturno"], "a nightlife flash portrait with a clean foreground and deep, colorful background"],
    ["rainy-window", ["Rainy window","빗방울 창문","雨滴窗景","雨滴窗景","Fenêtre sous la pluie","Regenfenster","Ventana lluviosa","Janela na chuva"], "a candid portrait behind a rain-streaked window with softly blurred street lights"],
    ["cinematic", ["Cinematic still","영화 스틸컷","电影剧照","電影劇照","Image de cinéma","Filmstill","Fotograma de cine","Cena de cinema"], "a cinematic still with balanced warm highlights, cool shadows and shallow depth of field"],
    ["photo-booth", ["Photo booth","포토부스","照相亭","拍貼機","Photomaton","Fotokabine","Fotomatón","Cabine fotográfica"], "a playful four-frame photo booth strip with different natural expressions"],
    ["photo-restoration", ["Photo restoration","오래된 사진 복원","老照片修复","老照片修復","Restauration photo","Fotorestaurierung","Restauración fotográfica","Restauração fotográfica"], "a crisply restored old portrait with scratches repaired and believable original detail"],
  ],
  art: [
    ["impressionist", ["Impressionist","인상주의 회화","印象派","印象派","Impressionnisme","Impressionismus","Impresionismo","Impressionismo"], "an impressionist painting with small expressive brushstrokes and luminous color"],
    ["oil-portrait", ["Oil portrait","유화 초상화","油画肖像","油畫肖像","Portrait à l’huile","Ölporträt","Retrato al óleo","Retrato a óleo"], "a classical oil portrait with subtle glazing and realistic brushwork"],
    ["gouache", ["Gouache","과슈 일러스트","水粉画","水粉畫","Gouache","Gouache","Gouache","Guache"], "a matte gouache portrait with broad opaque brushwork and a muted color palette"],
    ["graphite", ["Graphite sketch","흑연 스케치","石墨素描","石墨素描","Croquis au graphite","Grafitskizze","Boceto a grafito","Esboço a grafite"], "a graphite sketch on rough white paper with restrained pencil shading"],
    ["charcoal", ["Charcoal drawing","목탄 드로잉","炭笔绘画","炭筆繪畫","Fusain","Kohlezeichnung","Carboncillo","Carvão"], "a charcoal drawing with expressive black marks and soft dusty edges"],
    ["ink-wash", ["Ink wash","수묵화","水墨画","水墨畫","Lavis à l’encre","Tuschelavierung","Aguada de tinta","Pintura a nanquim"], "an East Asian ink wash painting with gray gradients and expressive brushlines"],
    ["colored-pencil", ["Colored pencil","색연필 드로잉","彩铅画","色鉛筆畫","Crayons de couleur","Buntstiftzeichnung","Lápices de colores","Lápis de cor"], "a colored-pencil illustration on textured cream paper"],
    ["crayon", ["Crayon portrait","크레용 그림","蜡笔画","蠟筆畫","Pastels à la cire","Wachsmalstifte","Ceras de colores","Giz de cera"], "an expressive wax-crayon drawing with bold, uneven, overlapping strokes"],
    ["acrylic", ["Acrylic painting","아크릴 채색","丙烯画","壓克力畫","Peinture acrylique","Acrylmalerei","Pintura acrílica","Pintura acrílica"], "a saturated acrylic painting with thick brush texture and crisp color fields"],
    ["pastel", ["Soft pastel","소프트 파스텔","软粉彩","軟粉彩","Pastel tendre","Softpastell","Pastel suave","Pastel suave"], "a soft pastel portrait with chalk textures and blended edges"],
    ["woodcut", ["Woodcut print","목판화","木版画","木版畫","Gravure sur bois","Holzschnitt","Xilografía","Xilogravura"], "a block-printed portrait with carved wood textures and two ink colors"],
    ["art-nouveau", ["Art Nouveau","아르누보","新艺术风格","新藝術風格","Art nouveau","Jugendstil","Art nouveau","Art nouveau"], "an original Art Nouveau poster portrait with flowing botanical ornament and no lettering"],
  ],
  animation: [
    ["manga", ["Manga ink","만화 원고","漫画墨稿","漫畫墨稿","Manga à l’encre","Manga-Tusche","Manga a tinta","Mangá a tinta"], "an original black-and-white manga illustration with screen tone and clean brush inking"],
    ["classic-cel", ["Classic cel animation","셀 애니메이션","赛璐珞动画","賽璐珞動畫","Animation sur cellulo","Klassische Cel-Animation","Animación clásica","Animação clássica"], "a hand-inked vintage cel-animation still with painted background and crisp shadow shapes"],
    ["webtoon", ["Webtoon character","웹툰 캐릭터","网漫角色","網漫角色","Personnage webtoon","Webtoon-Figur","Personaje de webtoon","Personagem de webtoon"], "a contemporary full-color webtoon portrait, clean line art, no speech bubbles"],
    ["pixel-art", ["Pixel portrait","픽셀 인물","像素人像","像素人像","Portrait pixelisé","Pixelporträt","Retrato pixelado","Retrato pixelado"], "a crisp 16-bit pixel-art portrait with a limited palette and no pixel blur"],
    ["retro-comic", ["Retro comic","레트로 코믹","复古连环画","復古連環畫","BD rétro","Retro-Comic","Cómic retro","Quadrinhos retrô"], "a retro comic-book portrait with bold black inking, halftone dots and primary colors"],
    ["pop-halftone", ["Pop-art halftone","팝아트 하프톤","波普网点","普普網點","Trame pop art","Pop-Art-Raster","Trama pop art","Retícula pop art"], "a graphic pop-art portrait with large halftone dots and striking two-color contrast"],
    ["mini-chibi", ["Mini chibi","미니 SD 캐릭터","迷你Q版","迷你Q版","Mini chibi","Mini-Chibi","Mini chibi","Mini chibi"], "an original chibi character with a round face, tiny body and expressive gesture"],
    ["low-poly", ["Low-poly portrait","로우폴리 캐릭터","低多边形角色","低多邊形角色","Portrait low poly","Low-Poly-Porträt","Retrato low poly","Retrato low poly"], "a low-poly vintage game-style portrait with angular 3D models and simple textures"],
    ["flat-vector", ["Flat illustration","플랫 일러스트","扁平插画","扁平插畫","Illustration à plat","Flache Illustration","Ilustración plana","Ilustração plana"], "a two-dimensional vector-style illustration with flat geometric shapes and bold color blocks"],
    ["clay-animation", ["Clay animation","클레이 애니메이션","黏土动画","黏土動畫","Animation en argile","Knetanimation","Animación con arcilla","Animação em argila"], "a clay animation character with hand-formed surfaces and studio-soft shadows"],
    ["felt-cartoon", ["Felt cartoon","펠트 일러스트","毛毡卡通","毛氈卡通","Dessin en feutre","Filz-Cartoon","Dibujo de fieltro","Desenho de feltro"], "a felt-cartoon portrait with visible seams and colorful fabric fibers"],
    ["paper-layers", ["Layered papercut","레이어드 종이 공예","分层剪纸","分層剪紙","Papier découpé en couches","Papiercollage","Papel recortado en capas","Papel recortado em camadas"], "a layered hand-cut paper portrait with visible thickness and shallow shadows"],
  ],
  miniature: [
    ["mini-room", ["Miniature room","미니어처 방","微缩房间","微縮房間","Pièce miniature","Miniaturzimmer","Habitación en miniatura","Quarto em miniatura"], "a detailed miniature model room inspired by the photo with tiny furniture and warm lighting"],
    ["collectors-tin", ["Collector’s tin","틴케이스 미니어처","铁盒微缩景","鐵盒微縮景","Boîte de collection","Sammeldose","Lata de colección","Lata de coleção"], "an illustrated collector's tin opened to reveal miniature photo mementos"],
    ["vinyl-figure", ["Vinyl figure","비닐 피규어","搪胶人偶","搪膠人偶","Figurine en vinyle","Vinylfigur","Figura de vinilo","Figura de vinil"], "an original shelf-ready vinyl figure with a compact silhouette and smooth matte surfaces"],
    ["plush-doll", ["Plush doll","봉제 인형","毛绒玩偶","毛絨玩偶","Poupée en peluche","Plüschpuppe","Muñeco de peluche","Boneco de pelúcia"], "a soft plush doll based on the subject, with stitched features and rounded fabric"],
    ["artisan-keycap", ["Artisan keycap","아트 키캡","手工键帽","手工鍵帽","Touche artisanale","Handgemachte Tastenkappe","Tecla artesanal","Tecla artesanal"], "a close-up of a handmade keycap featuring a tiny sculpted version of the subject"],
    ["enamel-pin", ["Enamel pin","에나멜 핀","珐琅徽章","琺瑯徽章","Broche émaillée","Emaille-Pin","Pin esmaltado","Pin esmaltado"], "a polished enamel pin version of the subject with metallic outlines and a simple felt backing"],
    ["ceramic-bust", ["Ceramic bust","도자기 흉상","陶瓷胸像","陶瓷胸像","Buste en céramique","Keramikbüste","Busto de cerámica","Busto de cerâmica"], "a glazed ceramic bust with visible kiln texture on a gallery shelf"],
    ["snow-globe", ["Snow globe","스노글로브","雪花球","雪花球","Boule à neige","Schneekugel","Bola de nieve","Globo de neve"], "a realistic snow globe with a tiny version of the subject and floating snow"],
    ["acrylic-stand", ["Acrylic stand","아크릴 스탠드","亚克力立牌","壓克力立牌","Figurine en acrylique","Acrylaufsteller","Figura de acrílico","Figura de acrílico"], "a collectible transparent acrylic stand carrying an illustration of the subject"],
    ["rail-diorama", ["Railway diorama","기차 디오라마","铁路微缩景","鐵路微縮景","Diorama ferroviaire","Eisenbahn-Diorama","Diorama ferroviario","Diorama ferroviário"], "a tiny model railway diorama showing the subject beside a small station"],
    ["paper-house", ["Paper house","종이 미니어처 집","纸房子","紙房子","Maison en papier","Papierhaus","Casa de papel","Casa de papel"], "a small folded-paper house interpreting the architecture and palette of the supplied photo"],
    ["brick-model", ["Building-brick model","조립 블록 모형","积木模型","積木模型","Maquette en briques","Bausteinmodell","Maqueta de bloques","Maquete de blocos"], "an original model built from colorful interlocking toy bricks with no brand markings"],
  ],
  style: [
    ["wave-hair", ["Soft waves","웨이브 헤어","柔和卷发","柔和捲髮","Ondulations souples","Sanfte Wellen","Ondas suaves","Ondas suaves"], "the same person with natural loose waves and their existing hair color"],
    ["straight-hair", ["Straight hair","생머리","直发","直髮","Cheveux lisses","Glattes Haar","Pelo liso","Cabelo liso"], "the same person with sleek straight hair, preserving the existing hair length where practical"],
    ["fringe", ["Soft fringe","앞머리 스타일","轻盈刘海","輕盈瀏海","Frange légère","Weicher Pony","Flequillo ligero","Franja suave"], "the same person with soft face-framing bangs that suit their hair texture"],
    ["short-bob", ["Classic bob","단발 보브","经典波波头","經典鮑伯頭","Carré classique","Klassischer Bob","Corte bob clásico","Corte bob clássico"], "the same person with a neat chin-length bob, maintaining recognizable facial features"],
    ["buzz-cut", ["Buzz cut","버즈컷","寸头","寸頭","Coupe très courte","Buzzcut","Corte rapado","Corte raspado"], "the same person with a short even buzz cut and natural hairline"],
    ["braided-hair", ["Braided hair","브레이드 헤어","编发","編髮","Tresses","Zöpfe","Trenzas","Tranças"], "the same person with carefully braided hair, preserving their apparent features"],
    ["ponytail", ["Low ponytail","로우 포니테일","低马尾","低馬尾","Queue de cheval basse","Tiefer Pferdeschwanz","Coleta baja","Rabo de cavalo baixo"], "the same person with a neatly secured low ponytail and naturally loose side strands"],
    ["auburn", ["Auburn color","어번 헤어 컬러","赤褐发色","赤褐髮色","Couleur auburn","Kastanienrot","Castaño cobrizo","Ruivo acobreado"], "the same hairstyle colored a warm auburn with natural highlights"],
    ["platinum", ["Platinum color","플래티넘 헤어 컬러","铂金发色","鉑金髮色","Blond platine","Platinblond","Rubio platino","Loiro platinado"], "the same hairstyle in a cool platinum tone with realistic shadow variation"],
    ["short-beard", ["Short beard","짧은 수염","短胡须","短鬍鬚","Barbe courte","Kurzer Bart","Barba corta","Barba curta"], "the same adult with a neat short beard while leaving all facial features unchanged"],
    ["round-glasses", ["Round glasses","동그란 안경","圆框眼镜","圓框眼鏡","Lunettes rondes","Runde Brille","Gafas redondas","Óculos redondos"], "the same person wearing thin round eyeglass frames that follow the face perspective"],
    ["soft-makeup", ["Soft makeup","소프트 메이크업","柔和妆容","柔和妝容","Maquillage léger","Dezentes Make-up","Maquillaje suave","Maquiagem suave"], "the same person with subtle warm makeup, natural skin texture and unchanged facial structure"],
  ],
  scene: [
    ["renaissance-gallery", ["Renaissance gallery","르네상스 초상","文艺复兴肖像","文藝復興肖像","Galerie Renaissance","Renaissance-Galerie","Galería renacentista","Galeria renascentista"], "a portrait in a Renaissance-era gallery setting, with dramatic fabric and warm oil-paint lighting"],
    ["art-deco-night", ["Art Deco evening","아르데코 저녁","装饰艺术之夜","裝飾藝術之夜","Soirée Art déco","Art-déco-Abend","Noche Art déco","Noite Art déco"], "the subject in a 1920s Art Deco lobby with polished brass and symmetrical geometry"],
    ["nordic-winter", ["Nordic winter","북유럽 겨울","北欧冬日","北歐冬日","Hiver nordique","Nordischer Winter","Invierno nórdico","Inverno nórdico"], "the subject in an airy snowy landscape with cool daylight and wool clothing"],
    ["glasshouse", ["Botanical glasshouse","식물원 온실","植物园温室","植物園溫室","Serre botanique","Botanisches Gewächshaus","Invernadero botánico","Estufa botânica"], "the subject inside a botanical glasshouse with soft diffused light and lush greenery"],
    ["graphic-city", ["Illustrated city","일러스트 도시","插画城市","插畫城市","Ville illustrée","Illustrierte Stadt","Ciudad ilustrada","Cidade ilustrada"], "the subject among vividly illustrated geometric city blocks and playful signs with no readable text"],
    ["celestial", ["Celestial portrait","별자리 인물","星空人像","星空人像","Portrait céleste","Himmelsporträt","Retrato celestial","Retrato celestial"], "a celestial scene with the subject lit against a deep sky, crescent moon and gentle star trails"],
    ["neon-city", ["Neon city","네온 야경","霓虹夜景","霓虹夜景","Ville néon","Neonstadt","Ciudad de neón","Cidade de neon"], "the subject on a neon-lit city street with reflections and a colorful night palette"],
    ["underwater", ["Underwater light","물속 햇살","水下光影","水下光影","Lumière sous-marine","Unterwasserlicht","Luz submarina","Luz subaquática"], "an artistic underwater portrait with gentle caustic light patterns and floating fabric"],
    ["mist-forest", ["Misty forest","안개 숲","雾林","霧林","Forêt brumeuse","Nebliger Wald","Bosque con niebla","Floresta enevoada"], "the subject in a quiet forest with mist and layered trees"],
    ["desert-sunset", ["Desert sunset","사막의 석양","沙漠日落","沙漠日落","Coucher de soleil dans le désert","Wüstensonnenuntergang","Atardecer en el desierto","Pôr do sol no deserto"], "the subject in a wide desert scene with terracotta sand and sunset shadows"],
    ["hanok-garden", ["Hanok garden","한옥 정원","韩屋庭院","韓屋庭院","Jardin hanok","Hanok-Garten","Jardín hanok","Jardim hanok"], "the subject in a quiet Korean hanok courtyard with warm sunlight and realistic architectural details"],
    ["stage-spotlight", ["Studio spotlight","스튜디오 스포트라이트","影棚聚光灯","棚拍聚光燈","Projecteur de studio","Studio-Spotlight","Foco de estudio","Holofote de estúdio"], "the subject in a theatrical studio set with a single textured spotlight and dramatic shadows"],
  ],
  design: [
    ["editorial-cover", ["Editorial cover","매거진 커버","杂志封面","雜誌封面","Couverture éditoriale","Editorial-Cover","Portada editorial","Capa editorial"], "an editorial cover composition with bold spacing and crop-safe room for a headline, no lettering"],
    ["vinyl-cover", ["Vinyl sleeve","LP 커버","黑胶封套","黑膠封套","Pochette vinyle","Plattencover","Portada de vinilo","Capa de vinil"], "a square record-cover composition based on the subject, with strong color and no lettering"],
    ["collectible-card", ["Collectible card","컬렉터 카드","收藏卡","收藏卡","Carte de collection","Sammelkarte","Carta coleccionable","Carta colecionável"], "an original collectible card layout with illustrated portrait framing and decorative fields, no lettering"],
    ["paper-collage", ["Cutout collage","종이 콜라주","剪贴拼贴","剪貼拼貼","Collage découpé","Scherenschnitt-Collage","Collage de recortes","Colagem recortada"], "a cutout collage with distinct torn photo layers and colored paper scraps"],
    ["zine-cover", ["Photocopied zine","복사기 진","复印小志","影印小誌","Fanzine photocopié","Kopiertes Fanzine","Fanzine fotocopiado","Zine fotocopiado"], "a black-and-white photocopied zine layout with high-contrast images and no readable text"],
    ["washi-scrapbook", ["Washi scrapbook","마스킹테이프 스크랩북","和纸手账","和紙手帳","Album washi","Washi-Scrapbook","Álbum con washi","Álbum com washi"], "a scrapbook spread assembled with washi tape, film-photo borders and textured paper"],
    ["embroidered-patch", ["Embroidered patch","자수 와펜","刺绣布贴","刺繡布貼","Écusson brodé","Bestickter Aufnäher","Parche bordado","Patch bordado"], "an embroidered fabric patch based on the subject, with thread texture and stitched edges"],
    ["nature-linocut", ["Nature linocut","보태니컬 리노컷","植物油毡版画","植物油氈版畫","Linogravure botanique","Botanischer Linolschnitt","Linograbado botánico","Linogravura botânica"], "a botanical linocut with strong positive and negative shapes from the image"],
    ["cyanotype", ["Cyanotype","시안타입 청사진","蓝晒","藍曬","Cyanotype","Cyanotypie","Cianotipia","Cianotipia"], "a deep-blue photographic cyanotype with paper texture and delicate highlights"],
    ["neon-outline", ["Neon line portrait","네온 라인 아트","霓虹线稿","霓虹線稿","Portrait au néon","Neonlinienporträt","Retrato de líneas de neón","Retrato de linhas neon"], "a dark portrait traced with a few continuous neon lines in a gallery setting"],
    ["prismatic-geometry", ["Geometric portrait","기하학 초상","几何肖像","幾何肖像","Portrait géométrique","Geometrisches Porträt","Retrato geométrico","Retrato geométrico"], "a portrait rebuilt from overlapping geometric shapes and a limited color palette"],
    ["double-exposure", ["Double exposure","이중 노출","双重曝光","雙重曝光","Double exposition","Doppelbelichtung","Doble exposición","Dupla exposição"], "a double exposure merging the subject silhouette with a soft landscape without obscuring likeness"],
  ],
  playful: [
    ["toy-box", ["Toy package","장난감 패키지","玩具包装","玩具包裝","Emballage de jouet","Spielzeugverpackung","Caja de juguete","Embalagem de brinquedo"], "an original toy-package display with the subject as a figurine and tiny accessories, no brands or words"],
    ["giant-city", ["Giant in the city","도시 속 거인","城市巨人","城市巨人","Géant en ville","Riese in der Stadt","Gigante en la ciudad","Gigante na cidade"], "a playful forced-perspective photo of the subject large among miniature-looking city blocks"],
    ["lawn-overhead", ["Overhead lawn","잔디밭 항공샷","草地俯拍","草地俯拍","Pelouse vue du ciel","Wiese von oben","Césped desde arriba","Grama vista de cima"], "a bright straight-down photo of the subject surrounded by a deep-green lawn and small flowers"],
    ["tilt-shift", ["Tilt-shift world","틸트시프트 세상","移轴微缩世界","移軸微縮世界","Monde tilt-shift","Tilt-Shift-Welt","Mundo tilt-shift","Mundo tilt-shift"], "a carefully lit tilt-shift scene making the setting look like a scale model"],
    ["fragmented-mirror", ["Fragmented mirror","조각 거울","碎镜倒影","碎鏡倒影","Miroir fragmenté","Spiegelfragmente","Espejo fragmentado","Espelho fragmentado"], "an abstract portrait reflected in angled pieces of mirror with no broken-glass danger imagery"],
    ["frosted-glass", ["Frosted silhouette","서리 낀 유리 실루엣","磨砂玻璃剪影","磨砂玻璃剪影","Silhouette derrière verre dépoli","Milchglas-Silhouette","Silueta tras vidrio esmerilado","Silhueta em vidro fosco"], "a soft recognizable outline behind frosted glass in warm diffused light"],
    ["rainbow-prism", ["Rainbow prism","무지개 프리즘","彩虹棱镜","彩虹稜鏡","Prisme arc-en-ciel","Regenbogenprisma","Prisma arcoíris","Prisma arco-íris"], "a tasteful portrait with a prism casting a small rainbow across the scene"],
    ["retro-computer", ["Retro computer room","레트로 컴퓨터 방","复古电脑房","復古電腦房","Salle informatique rétro","Retro-Computerzimmer","Cuarto de informática retro","Quarto de computador retrô"], "the subject in a cozy late-1990s computer room with a bulky CRT and pastel accessories"],
    ["cardboard-costume", ["Cardboard costume","골판지 코스튬","纸板服装","紙板服裝","Costume en carton","Pappkostüm","Disfraz de cartón","Fantasia de papelão"], "the subject dressed in a funny handmade cardboard robot costume"],
    ["holographic-display", ["Holographic display","홀로그램 전시","全息展品","全息展品","Affichage holographique","Holografische Anzeige","Exhibición holográfica","Exibição holográfica"], "the subject presented in a soft holographic gallery display with subtle colorful reflections"],
    ["pet-watercolor", ["Watercolor pet","반려동물 수채화","宠物水彩画","寵物水彩畫","Animal à l’aquarelle","Haustier als Aquarell","Mascota en acuarela","Pet em aquarela"], "a warm watercolor illustration of the supplied pet with loose brushwork and paper texture"],
    ["pet-astronaut", ["Astronaut pet","우주비행 반려동물","宠物宇航员","寵物太空人","Animal astronaute","Haustier als Astronaut","Mascota astronauta","Pet astronauta"], "a whimsical portrait of the supplied pet as an astronaut in a tiny helmet with a starry background"],
  ],
} satisfies Record<StudioPhotoCategory, readonly CatalogRow[]>;

export const STUDIO_PHOTO_PRESETS: readonly StudioPhotoPreset[] = [
  { id: "film", category: "film", tool: "illustration", artwork: "preset-film.webp", names: ["Film portrait","필름 인물","胶片人像","底片人像","Portrait argentique","Analogporträt","Retrato analógico","Retrato analógico"], style: "warm analog film photography, with fine grain and natural light" },
  { id: "anime", category: "animation", tool: "illustration", artwork: "preset-anime.webp", names: ["Anime","애니메이션","动漫","動漫","Anime","Anime","Anime","Anime"], style: "hand-drawn cel animation with a hand-painted background" },
  { id: "3d", category: "animation", tool: "illustration", artwork: "preset-3d.webp", names: ["3D character","3D 캐릭터","3D 角色","3D 角色","Personnage 3D","3D-Figur","Personaje 3D","Personagem 3D"], style: "tactile stylized 3D character render with soft lighting" },
  { id: "watercolor", category: "art", tool: "illustration", artwork: "illustration.png", names: ["Watercolor","수채화","水彩","水彩","Aquarelle","Aquarell","Acuarela","Aquarela"], style: "watercolor illustration" },
  { id: "caricature", category: "animation", tool: "caricature", artwork: "caricature.png", names: ["Caricature","캐리커처","漫画肖像","漫畫肖像","Caricature","Karikatur","Caricatura","Caricatura"] },
  { id: "transparent", category: "design", tool: "transparent-png", artwork: "cat.png", names: ["Transparent PNG","투명 PNG","透明 PNG","透明 PNG","PNG transparent","Transparentes PNG","PNG transparente","PNG transparente"] },
  ...STUDIO_PHOTO_CATEGORIES.flatMap(category => photoCatalog[category].map(([id, names, style]): StudioPhotoPreset => ({
    id, category, names, style, tool: "illustration", artwork: "effects/" + id + ".webp",
  }))),
];

export type StudioPublication = "poster" | "social-post";
export type StudioPublicationPreset = { id: string; names: Names; direction: string; artwork: string };
const publicationCatalog = {
  poster: [
    ["music-festival", ["Music festival","음악 페스티벌","音乐节","音樂節","Festival de musique","Musikfestival","Festival de música","Festival de música"], "bold outdoor music festival with sunset colors, crowd silhouettes and guitar shapes"],
    ["cafe-menu", ["Café menu","카페 메뉴","咖啡馆菜单","咖啡館菜單","Menu de café","Cafékarte","Menú de café","Cardápio de café"], "warm coffeehouse menu artwork with iced coffee and muted cream paper"],
    ["gallery-opening", ["Gallery opening","갤러리 오프닝","画廊开幕","畫廊開幕","Vernissage","Galerie-Eröffnung","Inauguración de galería","Abertura de galeria"], "a contemporary exhibition opening, off-white editorial composition and abstract sculpture"],
    ["creative-workshop", ["Creative workshop","창작 워크숍","创意工作坊","創意工作坊","Atelier créatif","Kreativworkshop","Taller creativo","Oficina criativa"], "print workshop poster art with bright ink blocks and brushes"],
    ["sports-event", ["Sports event","스포츠 행사","体育活动","體育活動","Événement sportif","Sportveranstaltung","Evento deportivo","Evento esportivo"], "fast-paced sports event artwork with athletic motion and sharp green court markings"],
    ["farmers-market", ["Farmers’ market","파머스 마켓","农夫市集","農夫市集","Marché fermier","Bauernmarkt","Mercado de productores","Feira de produtores"], "friendly farmers market poster with seasonal fruit, rustic ink and warm outdoor colors"],
    ["film-screening", ["Film screening","영화 상영회","电影放映会","電影放映會","Projection de film","Filmvorführung","Proyección de cine","Sessão de cinema"], "independent film screening artwork, midnight blue shadows and simple projected light"],
    ["grand-opening", ["Grand opening","그랜드 오픈","盛大开业","盛大開幕","Grande ouverture","Neueröffnung","Gran inauguración","Grande inauguração"], "small shop opening design with ribbons and bold coral graphics"],
    ["birthday-invite", ["Birthday invitation","생일 초대장","生日邀请函","生日邀請函","Invitation d’anniversaire","Geburtstagseinladung","Invitación de cumpleaños","Convite de aniversário"], "a joyful birthday invitation with confetti, layered cake and saturated pastels"],
    ["wedding-invite", ["Wedding invitation","웨딩 초대장","婚礼邀请函","婚禮邀請函","Invitation de mariage","Hochzeitseinladung","Invitación de boda","Convite de casamento"], "an elegant wedding invitation with flowers, ivory linen textures and thin borders"],
    ["community-meetup", ["Community meetup","커뮤니티 모임","社区聚会","社區聚會","Rencontre communautaire","Community-Treffen","Encuentro comunitario","Encontro comunitário"], "a community gathering announcement, friendly editorial illustration and soft teal"],
    ["travel-print", ["Travel print","여행 포스터","旅行海报","旅行海報","Affiche de voyage","Reiseposter","Póster de viaje","Pôster de viagem"], "retro coastal travel print, sun and landscape with soft lithograph texture"],
    ["book-fair", ["Book fair","북페어","书展","書展","Salon du livre","Buchmesse","Feria del libro","Feira do livro"], "independent book fair artwork with layered books and inky texture"],
    ["wellness-retreat", ["Wellness retreat","웰니스 리트리트","疗愈静修","療癒靜修","Retraite bien-être","Wellness-Retreat","Retiro de bienestar","Retiro de bem-estar"], "calm retreat art with mineral tones, mountains, and plenty of breathing room"],
    ["theater-night", ["Theater night","연극 공연","戏剧演出","戲劇演出","Soirée théâtre","Theaterabend","Noche de teatro","Noite de teatro"], "dramatic theatrical poster artwork with curtains and a warm beam of light"],
    ["holiday-market", ["Holiday market","홀리데이 마켓","节日市集","節日市集","Marché de fêtes","Festtagsmarkt","Mercado navideño","Feira de fim de ano"], "winter holiday market poster art with fir branches, paper stars and deep red"],
  ],
  "social-post": [
    ["photo-dump", ["Photo dump","사진 모아보기","照片合集","照片合集","Pêle-mêle photo","Fotocollage","Recopilación de fotos","Compilado de fotos"], "a feed collage arranged like a tasteful camera roll, warm photo corners and cheerful everyday snapshots"],
    ["travel-story", ["Travel story","여행 스토리","旅行动态","旅行限動","Story de voyage","Reise-Story","Historia de viaje","Story de viagem"], "a stylish travel story template with a sunny coastline, postcard framing and room for an overlay"],
    ["food-review", ["Food review","맛집 리뷰","美食测评","美食評測","Critique culinaire","Restaurantkritik","Reseña gastronómica","Resenha gastronômica"], "a food review post with a crisp overhead brunch shot, warm backdrop and small graphic rating markers"],
    ["new-product", ["Product launch","신제품 공개","新品发布","新品發表","Lancement de produit","Produktstart","Lanzamiento de producto","Lançamento de produto"], "clean product launch post, circular spotlight and a simple unbranded object"],
    ["flash-sale", ["Flash sale","타임 세일","限时特卖","限時特賣","Vente flash","Blitzangebot","Oferta relámpago","Oferta relâmpago"], "energetic promo design with orange blocks, bold negative space and diagonal graphic accents"],
    ["quote-card", ["Quote card","문장 카드","语录卡","語錄卡","Carte de citation","Zitatkarte","Tarjeta de cita","Cartão de frase"], "an elegant quote-card composition with botanical decoration, soft pink and uncluttered text area"],
    ["before-after", ["Before and after","전후 비교","前后对比","前後對比","Avant-après","Vorher-Nachher","Antes y después","Antes e depois"], "a clean before-and-after split layout with a houseplant and distinct side-by-side border framing"],
    ["countdown", ["Event countdown","이벤트 카운트다운","活动倒计时","活動倒數","Compte à rebours","Event-Countdown","Cuenta regresiva","Contagem regressiva"], "a graphic countdown template with a colored timer-shaped motif and dramatic negative space"],
    ["daily-log", ["Daily log","일상 기록","日常记录","日常記錄","Journal du jour","Tagesjournal","Diario cotidiano","Diário do dia"], "a warm daily reflection post with a notebook, small film image, and cream background"],
    ["book-review", ["Book review","책 리뷰","书评","書評","Critique de livre","Buchrezension","Reseña de un libro","Resenha de livro"], "a book review post with a book on linen, warm shadows and editorial margin"],
    ["portfolio-showcase", ["Portfolio showcase","포트폴리오 소개","作品集展示","作品集展示","Présentation de portfolio","Portfolio-Showcase","Presentación de portafolio","Apresentação de portfólio"], "a portfolio announcement for creative work, grids of two beautiful image crops and lots of white"],
    ["music-release", ["Music release","음악 발매","音乐发行","音樂發行","Sortie musicale","Musikrelease","Lanzamiento musical","Lançamento musical"], "a music release post with vivid teal and black audio artwork and a round vinyl motif"],
    ["weekly-planner", ["Weekly planner","주간 계획","每周计划","每週計畫","Planning hebdomadaire","Wochenplaner","Planificador semanal","Planejador semanal"], "a clean weekly planner social post with colorful stationery and open rectangular spaces"],
    ["recipe-card", ["Recipe card","레시피 카드","食谱卡","食譜卡","Fiche recette","Rezeptkarte","Tarjeta de receta","Cartão de receita"], "a recipe card post with citrus, warm ceramics and well-spaced small ingredient images"],
    ["question-card", ["Question card","질문 카드","提问卡","提問卡","Carte de question","Fragekarte","Tarjeta de pregunta","Cartão de pergunta"], "a playful interactive question card graphic with speech bubbles and bold lavender and ochre colors"],
    ["milestone", ["Milestone announcement","기념 소식","里程碑动态","里程碑消息","Annonce d’une étape","Meilenstein-Meldung","Anuncio de un logro","Anúncio de conquista"], "a heartfelt milestone announcement with confetti, warm paper and editorial space"],
  ],
} satisfies Record<StudioPublication, readonly CatalogRow[]>;

export const studioPublicationPresets = (kind: StudioPublication): StudioPublicationPreset[] =>
  publicationCatalog[kind].map(([id, names, direction]) => ({
    id, names, direction, artwork: "effects/" + kind + "-" + id + ".webp",
  }));
