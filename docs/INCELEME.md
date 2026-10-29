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

## Bilerek yapmadıklarım

- GitHub/GitLab hesabı bağlama, pull request listesi: kimlik bilgisi ve
  dış servis gerektiriyor; senin onayın olmadan eklemedim.
- Gravatar avatarları: e-posta hash'ini dışarı göndermek demek; onun yerine
  baş harfler kullanılıyor.
- Push/pull'u gerçek bir uzak sunucuya (GitHub) karşı denemedim; testler
  yerel bare repolarla. Kendi anahtarınla bir kez denemen iyi olur.
- Commit imzası yalnızca "signed" rozeti olarak gösteriliyor, doğrulanmıyor.

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
