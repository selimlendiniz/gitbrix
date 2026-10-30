# gitbrix — inceleme rehberi

Bu dosya, gece boyunca kendi başıma geliştirdiğim uygulamayı topluca
incelemen için. Ayrıntılı geliştirme günlüğü `PROGRESS.md`'de (İngilizce).

## Çalıştırma

```bash
cd ~/codes/gitbrix
pnpm install                       # ilk sefer
pnpm tauri dev                     # uygulamayı aç
```

Repoyu açılış ekranından seç, yolunu yapıştır ya da klasörü pencereye
sürükleyip bırak. Derlenmiş binary yolu argüman olarak da alır:
`src-tauri/target/release/gitbrix ~/codes/proje`.

Denemek için hazır bir demo repo (branch'ler, merge'ler, stash, tag'ler,
remote ve kaydedilmemiş değişiklikler):

```bash
scripts/demo-repo.sh /tmp/gitbrix-demo
# sonra uygulamada /tmp/gitbrix-demo/demo-app'i aç
```

Kurulabilir paket (release derlemesi):
`src-tauri/target/release/bundle/rpm/gitbrix-0.1.0-1.x86_64.rpm`
(kurmak için `sudo dnf install <yol>` — bunu ben yapmadım).

## Denenecekler (sırayla)

1. **Graph**: branch'ler şeritlerde, main solda düz durmalı. Satıra tıkla:
   sağda commit ayrıntısı. Ctrl/Shift+tık ile ikinci commit → karşılaştırma.
2. **Diff**: dosyaya tıkla → renklendirilmiş diff; Unified/Split; History ve
   Blame bağlantıları.
3. **WIP satırı** (en üstte `// WIP`): dosyaları stage et (+ düğmesi, çift
   tık ya da Space), diff'te satıra tıklayıp yalnızca o satırı stage et,
   özet yazıp Ctrl+Enter ile commit.
4. **Undo** (Ctrl+Z): az önceki commit'i geri al.
5. **Sağ tık menüleri**: commit (cherry-pick, revert, reset, interactive
   rebase…), branch etiketi (merge, rebase, push to…, worktree…), dosya
   (ignore, history, blame, aç).
6. **Sürükle-bırak** (bırakınca menü açılır; Esc iptal eder):
   - branch → başka branch: merge / rebase
   - branch → commit satırı: branch'i oraya taşı (checkout'lu olanda
     reset / rebase seçenekleri)
   - branch ya da tag → soldaki remote (origin): push
   - commit → checkout'lu branch: cherry-pick; başka branch: oraya taşı
   - commit → başka commit: iki commit'i karşılaştır
   - stash → en üstteki WIP satırı: apply / pop
   - dosya: Unstaged ↔ Staged listeleri arasında (doğrudan stage/unstage)
   - interactive rebase ekranında satırları sürükleyerek sırala
7. **Interactive rebase**: eski bir commit'e sağ tık → "Interactive rebase
   from here…" → sırala, reword, squash, drop.
8. **Conflict**: iki branch'te aynı satırı değiştirip merge et → conflict
   görünümünde Ours/Theirs/Both → "Save & mark resolved" → üstteki
   şeritten Continue.
9. **Ctrl+K** komut paleti, **Ctrl+F** arama (Message / Files / Code
   modları), **?** kısayol listesi.
10. **Ayarlar** (sağ üstteki dişli): açık tema, tarih biçimi, dosya ağacı,
    otomatik fetch.
11. Repo menüsü (sol üstte repo adı): Clone, New repository, Reflog.
12. Bir resim dosyasını değiştirip commit'le → diff'te öncesi/sonrası yan
    yana. Commit diff'lerinde "Ignore whitespace" kutusu.
13. En üstteki commit'e sağ tık → "Edit commit message…".
14. Bir branch etiketinin üzerine gel → o dalın commit'leri öne çıkar.
15. Ayarlar → Accounts → "Add account…": GitHub/GitLab token'ını ekle,
    sonra https remote'lu bir repoda push/pull dene.
16. Hesabı olan bir repoda sol panelde "Pull Requests": çift tık checkout,
    sağ tık → tarayıcıda aç / Approve. Başka biri onaylayabileceğin bir
    MR açınca masaüstü bildirimi gelir (3 dakikada bir kontrol).
17. Araç çubuğunda sağ üstteki PR simgesi: açık reponun MR/PR'ları
    (To review / Mine / Assigned / All); satıra tıklayınca uygulamada açılır.
18. **Workspaces** (başlık çubuğunda en soldaki sabit sekme): solda
    workspace listesi (+ ile yenisi, sağ tıkla yeniden adlandır / sil),
    sağda seçilenin repoları. "Add → All repositories in a folder…" ile
    `~/codes`'u seç; her repo için branch, ↑↓, değişen dosya sayısı.
    "Fetch all" hepsini çeker, satıra tıklamak repoyu kendi sekmesinde açar.
    Uygulama bu sekmeyle açılır (son repo arkada hazır bekler).
    "Pull requests" düğmesi workspace'teki tüm repoların MR'larını birlikte
    listeler; repo satırlarında da MR sayısı görünür.
19. **Profiller** (Ayarlar → Profiles): iş ve kişisel için ad/e-posta,
    klasör kuralı (örn. `~/codes/is`) ve kullanılacak hesaplar. Sağ
    üstteki yeşil noktalı düğmeden geçiş yapılır; commit formunun altında
    "as Ad <e-posta> · profile İş" yazar.
20. **Terminal**: Ctrl+` ya da sağ üstteki terminal simgesi; repo
    klasöründe senin kabuğun açılır, her sekmenin kendi terminali var.
21. **PR/MR açma**: bir branch'e sağ tık → "Create pull request…" (ya da
    sol paneldeki Pull Requests başlığındaki +). Hedef branch, reviewer,
    draft; branch remote'ta yoksa önce push edilir.
22. **PR'ı uygulamada inceleme**: sol paneldeki bir MR'a tıkla → sağda
    Files (diff'ler uygulamada) ve Conversation (yorumlar, yorum yazma),
    Approve…, Merge… (squash / merge commit, kaynak branch'i silme).
23. **CI durumu**: commit satırlarında ✓ / ✕ / ● işaretleri (tıklayınca
    pipeline açılır), MR'larda da aynı işaret.
24. **Merge editörü**: conflict'li dosyaya tıkla → üstte Ours / Base /
    Theirs yan yana, altta düzenlenebilir sonuç; ◀ ▶ ile conflict'ler
    arasında gez, düğmelerle seç ya da elle yaz, "Save & mark resolved".
25. **Git LFS**: git-lfs kurulu olmadan çalışır. Untracked bir dosyaya
    sağ tık → "Track *.uzantı with Git LFS". LFS'li repolarda checkout /
    pull sonrası dosyalar kendiliğinden indirilir, push'ta nesneler önce
    yüklenir.
26. **Patch**: commit'e sağ tık → "Save as patch…" / "Copy as patch";
    iki commit seçiliyken sağ panelde "Save as patch…" (aralık). Repo
    menüsü → "Apply patch as commits…" (git am) ya da "…to working tree"
    (git apply).

27. **Çoklu seçim**: grafikte Ctrl+tık (ekle/çıkar), Shift+tık (aralık).
    İki commit → karşılaştırma + "Cherry-pick both / Revert both / Squash
    into one"; üç ve üstü → sağda "N commits selected" paneli (cherry-pick,
    revert, squash, patch). Sağ tık da aynı menüyü açar.
28. **Branch temizliği**: sol panelde Local başlığındaki çöp kutusu (ya da
    repo menüsü → Clean up branches…). Merge edilmişler işaretli gelir;
    remote'u silinmiş ("gone") ve remote'taki merge edilmiş branch'ler
    ancak işaretlersen silinir. Yerel silmeler Ctrl+Z ile geri gelir.
29. **Otomatik stash**: değişikliklerin bir checkout / pull / merge'ün
    önünü keserse "Stash and carry on" sorulur; stash'lenir, işlem yapılır,
    değişiklikler geri konur. Ayarlar → Auto-stash → Always ile sormaz.
30. **Bisect**: bir commit'e sağ tık → "Bisect: mark bad", daha eski bir
    commit'e → "this one is good (start)". Üstteki şeritte Good / Bad /
    Skip ya da "Run a command…" (örn. `cargo test`); bulunca ilk kötü
    commit grafikte "first bad" etiketiyle seçilir.
31. **PR'da satıra yorum**: PR panelinde bir dosyayı aç, satırın solundaki
    + ile yorum yaz (Ctrl+Enter gönderir). Var olan satır yorumları da
    satırın altında görünür (unified görünümde).
32. **Release**: tag'e sağ tık → "Create release…"; notlar önceki tag'den
    bu yana commit'lerle dolar, tag önce push edilir.
33. **Dosya ağacı**: commit panelinde "Browse files" (ya da commit'e sağ
    tık → Browse files at this commit): o commit'teki tüm dosyalar,
    renklendirilmiş içerik, History / Blame bağlantıları.
34. **İstatistikler**: repo menüsü → Statistics: toplamlar, haftalık
    commit grafiği, gün × saat ısı haritası, katkıcılar, en çok değişen
    dosyalar (tıklayınca geçmişi açılır).
35. **Başlık çubuğu**: soldaki gitbrix logosu menü (aç, klonla, son
    repolar, ayarlar, hakkında, çıkış). Ortadaki arama kutusu komut
    paletini açar (araç çubuğundaki büyüteç kaldırıldı). Sekmelerde
    sarı nokta = commit'lenmemiş değişiklik (kırmızı = çakışma), ↑ push
    edilecek, ↓ çekilecek commit. Çok sekme açınca sağda ⌄ çıkar, tüm
    sekmeleri listeler; fare tekerleği sekmeleri yana kaydırır.
36. **Zil**: tüm hesaplarda seni ilgilendiren PR/MR'lar; sayı = senin
    onayını/incelemeni bekleyenler. Repo uygulamada açıksa tıklayınca
    uygulama içinde inceleme açılır, değilse tarayıcıda.
37. **Arka plan işleri**: otomatik fetch, workspace fetch, PR kontrolü
    çalışırken başlıkta dönen simge; bir şey hata verirse kırmızı sayı,
    tıklayınca son hatalar (toast'lar kaybolsa da burada kalır), Clear.
38. **Hesap düğmesi**: sağdaki avatar: kim olarak commit atıldığı,
    hesaplar, profil değiştirme.
39. **Gravatar**: grafikteki commit noktalarında, yazar sütununda, commit
    panelinde ve istatistiklerde yazar resimleri. GitHub noreply
    adreslerinde GitHub profil resmi. Disk önbelleği: bir hafta. Ayarlar →
    Author pictures → Initials only ile kapanır.

40. **Issue'lar**: kenar çubuğunda "Issues" (sana atananlar üstte, "mine"
    yalnızca seninkiler). Tıklayınca ayrıntı, "Start work on a branch…"
    `12-baslik` adlı branch'i remote'un main'inden açar. O branch'teyken
    commit kutusunda "+ Closes #12" çıkar.
41. **Çakışma uyarısı**: araç çubuğunda, branch adının yanında "Conflicts
    with N branches" (kırmızı) ya da "N branches changed your files"
    (sarı). Tıklayınca hangi branch'te hangi dosya; değişen dosyaların
    yanında ⚠ işareti.
42. **Merge eklentileri**: PR'ın CI'ı çalışırken "Merge when checks pass"
    (servis, CI geçince kendisi merge eder). PR'ın branch'indeysen
    "Then switch to main, pull, and delete the local …": push edilmemiş
    commit varsa yerel branch silinmez.
43. **Çoklu pencere**: Ctrl+Shift+N, logo menüsü → New window, ya da sekmeye
    sağ tık → Move to new window. Ctrl+Q bütün pencereleri kapatır. Yalnızca
    ilk pencere sekmelerini hatırlar ve PR bildirimi gönderir.
44. **Ayar dosyası**: Ayarlar → Settings file → Export/Import. Token
    yazılmaz; içe aktarılan hesaplar Accounts'ta "needs a token" olarak
    bekler.
45. **Güncelleme**: Ayarlar → Updates'e bir `latest.json` adresi yazılır;
    About'tan kontrol/kurulum. Sürüm çıkarmak: `scripts/release.sh
    <adres> "notlar"` → `release/<sürüm>/` klasörünü o adrese yükle.
    İmza anahtarı `~/.tauri/gitbrix.key` (repoda değil): **yedeğini al**,
    kaybolursa kurulu kopyalar yeni sürümü doğrulayamaz.
46. **Flatpak**: `scripts/flatpak.sh` → kullanıcıya kurar (`flatpak run
    dev.gitbrix.app`) ve `release/gitbrix.flatpak` yazar. Terminal, hook,
    gpg, ssh sandbox dışında, senin sisteminde çalışır.

47. **PR'ı olan branch'ler**: graftaki etikette ve kenar çubuğunda branch
    adının yanında PR numarası (`!5`). Sarı: senin incelemen/onayın
    bekleniyor; yeşil: onaylandı; kırmızı: CI başarısız; kesikli: draft.
    Tıklayınca PR uygulamada açılır.

48. **Markdown**: PR/MR açıklaması, yorumlar, diff'teki satır yorumları ve
    issue metni GitLab/GitHub'ın kendi çevirdiği HTML ile gösteriliyor
    (GitLab: GraphQL `bodyHtml`/`descriptionHtml`; GitHub: `body_html`).
    Yani `#12`, `!4`, `@kişi` bağlantı, emoji, kod renkleri web'deki gibi.
    HTML uygulamada yeniden temizleniyor (GitHub'ın izin listesi; script,
    stil, olay yok; sayfadan gelen sınıflar uygulamanın stillerine
    ulaşamaz). Servis HTML vermezse metin uygulamada çevriliyor. Bağlantılar
    tarayıcıda açılır; resimler bağlantı olarak çıkar.

## Bilerek yapmadıklarım

- PR satır yorumları yalnızca unified diff görünümünde; split görünümde
  gösterilmiyor ve yazılamıyor.
- Release ve satır yorumu gerçek bir servise karşı denenmedi (yazma
  işlemi); testler sahte sunucuyla.
- LFS: git-lfs'in "locking" özelliği ve hunk/satır bazında stage yok;
  büyük dosyalar yüklenirken bellek yerine akışla gönderiliyor ama
  indirme/yükleme sırasında iptal düğmesi yok.
- PR açma, merge ve yorum gerçek bir servise karşı denenmedi (yazma
  işlemi); testler sahte sunucuyla. Okuma tarafı GitLab test projende
  canlı denendi.

- Gravatar açık geliyor (sen istedin): yazarların e-posta adreslerinin
  SHA-256 hash'i gravatar.com'a gidiyor. İstemezsen Ayarlar → Author
  pictures → Initials only.
- Push/pull'u gerçek bir uzak sunucuya (GitHub) karşı denemedim; testler
  yerel bare repolarla. Kendi anahtarınla bir kez denemen iyi olur.
- Commit imzası yalnızca "signed" rozeti olarak gösteriliyor, doğrulanmıyor.
- Güncelleme adresi boş geliyor: yayın yeri (GitHub/GitLab release, kendi
  sunucun) senin kararın. Hiçbir şey yüklemedim.
- Flatpak'te ssh ile push/pull ve gpg imzası denenmedi (flatpak-spawn ile
  ana sistemde çalışacak şekilde yazıldı); terminal denendi.
- Issue açma/kapama, yorum yok; yalnızca liste, ayrıntı ve branch başlatma.

## Bilmen gerekenler

- Uygulama `git` programına ihtiyaç duymuyor; her şey libgit2 ile. Yine
  de hook'ların çalışıyor, `commit.gpgsign` açıksa commit'ler imzalanıyor,
  ssh remote'lar sistemdeki `ssh` ile bağlanıyor (`~/.ssh/config`, agent,
  known_hosts geçerli).
- https için Ayarlar → Accounts: GitHub ya da GitLab (self-hosted ise
  sunucu adresi) ve access token. Token eklenirken API'den doğrulanıyor,
  KWallet'ta saklanıyor ve yalnızca o sunucuya https ile gönderiliyor.
- Otomatik fetch varsayılan olarak kapalı (ssh anahtarın agent'ta değilse
  her seferinde parola penceresi açılırdı).
- Testler: `pnpm test:rust`, `pnpm test:unit`, `pnpm test:ui`,
  `pnpm test:e2e` (son ikisi Chrome ve Xvfb kullanıyor).
- Hiçbir şeyi push etmedim; tüm commit'ler yerel `main` dalında.
