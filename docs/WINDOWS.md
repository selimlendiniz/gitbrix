# Windows: Rust testleri

Windows 11 ve Rust 1.99.1 üzerinde `cargo test` sonuçları.

| Git ayarı | Sonuç |
|---|---|
| `core.autocrlf=false` | 157 geçti, 0 hata, 7 atlandı |
| Git for Windows varsayılanı (`core.autocrlf=true`) | 145 geçti, 12 hata, 7 atlandı |

## Açık konular

### Testler `core.autocrlf=true` ile düşüyor

12 test `\n` bekleyip `\r\n` okuyor. Uygulama hatası değil, testler bu ayarı
hesaba katmıyor. Düşmeden çalıştırmak için `core.autocrlf=false` yazılı bir
`.gitconfig` içeren geçici bir klasörü `HOME` ve `USERPROFILE` yapın,
`CARGO_HOME` ve `RUSTUP_HOME` değerlerini gerçek klasörlerde bırakın.

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

`ops::rename_remote` artık önce değerleri kontrol ediyor. Windows'ta `url` ve
`pushurl` içindeki ters bölüler `/` oluyor, yani yeniden adlandırılan remote'un
adresi `C:\repos\x` yerine `C:/repos/x` görünüyor. Başka değerlerde ters bölü,
tırnak ya da satır sonu varsa işlem hata mesajıyla duruyor ve config değişmiyor.

### Dosya yolu araması (`search_history_by_file_and_code`)

git2, Windows'ta `pathspec` içindeki ters bölüleri `/` yapıyor (`util.rs`,
`fixup_windows_path`). Bu yüzden `*\**` deseni `*/**` oluyor ve `*` düz karakter
sayılmıyordu. `history::search` artık yolu desen olmadan, büyük/küçük harf
ayırmadan karşılaştırıyor. Windows'ta sorguya yazılan `\` önceden olduğu gibi
`/` sayılıyor.

### Test düzeltmeleri

- `paths_are_literal_not_globs`: Windows dosya adında `*` kabul etmediği için
  test `a*b.txt` yerine `a[x]b.txt` kullanıyor. Bu ad da desen olarak `axb.txt`
  ile eşleşir, yani test aynı şeyi kontrol ediyor.
- `workspace_finds_repositories_in_a_folder`: beklenen yol
  `Path::new("group").join("b")` ile kuruluyor.
