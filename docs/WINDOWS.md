# Windows: Rust testleri

Windows 11 ve Rust 1.99.1 üzerinde `2e15f6f` commit'inde alınan `cargo test`
sonucu: Git for Windows varsayılanı (`core.autocrlf=true`) ile 160 geçti, 0 hata,
7 atlandı. `core.autocrlf=false` bu commit'te yeniden çalıştırılmadı.

## Açık konular

### Branch yeniden adlandırma

libgit2 config bölümünü taşırken değerleri kaçırmıyor (aşağıya bakın). Branch
yeniden adlandırma da aynı kod yolunu kullanıyor, `branch.<ad>.*` değerlerinde
ters bölü ya da tırnak varsa aynı bozulma olabilir. Denenmedi, düzeltilmedi.

## Düzeltilen hatalar

### Remote yeniden adlandırma (`remote_management_and_targeted_push`)

libgit2 `git_config_rename_section` içinde değerleri kaçırmadan yazıyor. Ters
bölülü bir URL, `.git/config` dosyasını okunamaz hale getiriyordu
(`invalid escape at ...`). `\b` gibi geçerli bir kaçış dizisi denk gelirse değer
hata vermeden değişiyordu.

libgit2 ayrıca bütün config seviyelerini geziyor, ama yalnızca repo seviyesinden
silebiliyor. `~/.gitconfig` içinde `remote.<ad>.*` varsa işlem yarıda kalıyor
(`could not find key ... to delete`) ve `.git/config` içinde yarım bir bölüm
bırakıyor.

`ops::rename_remote` artık önce bütün değerleri kontrol ediyor ve işlem
yapılamayacaksa hiçbir şey yazmıyor. Windows'ta `url` ve `pushurl` içindeki ters
bölüler `/` oluyor, yani yeniden adlandırılan remote'un adresi `C:\repos\x`
yerine `C:/repos/x` görünüyor. İşlem şu durumlarda hata mesajıyla duruyor ve
config değişmiyor:

- Başka bir değerde ters bölü, tırnak ya da satır sonu var.
- Ters bölülü bir `url` ya da `pushurl` birden çok değere sahip.
- Bölümün bir değeri repo dışındaki bir config seviyesinden geliyor.

### Dosya yolu araması (`search_history_by_file_and_code`)

git2, Windows'ta `pathspec` içindeki ters bölüleri `/` yapıyor (`util.rs`,
`fixup_windows_path`). Bu yüzden `*\**` deseni `*/**` oluyor ve `*` düz karakter
sayılmıyordu. `history::search` artık yolu desen olmadan, büyük/küçük harf
ayırmadan karşılaştırıyor. Windows'ta sorguya yazılan `\` önceden olduğu gibi
`/` sayılıyor.

### Test düzeltmeleri

- `core.autocrlf=true`: 12 test `\n` bekleyip `\r\n` okuyordu. Testler artık
  çalışma ağacındaki dosyaları `read_lf` ile okuyor, `HOME` değiştirmek gerekmiyor.
  Bu ayarla bütün testler Linux'ta ve Windows'ta geçiyor.
- `paths_are_literal_not_globs`: Windows dosya adında `*` kabul etmediği için
  test `a*b.txt` yerine `a[x]b.txt` kullanıyor. Bu ad da desen olarak `axb.txt`
  ile eşleşir. `*` karakterini `a_star_in_a_path_is_literal` testi yalnızca
  Unix'te deniyor.
- `workspace_finds_repositories_in_a_folder`: beklenen yol
  `Path::new("group").join("b")` ile kuruluyor.
