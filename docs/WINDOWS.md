# Windows: açık Rust test hataları

Windows 11, Rust 1.99.1, `ae90137` üzerinde `cargo test --lib` sonucu.
Hataların hiçbiri henüz düzeltilmedi.

## Çalıştırma

Git for Windows sistem ayarında `core.autocrlf=true` ile gelir. Bu ayar açıkken
11 test daha düşer, çünkü `\n` bekleyip `\r\n` okurlar. Aşağıdaki 4 hatayı tek
başına görmek için `core.autocrlf=false` yazılı bir `.gitconfig` içeren geçici
bir klasörü `HOME` ve `USERPROFILE` yapın, `CARGO_HOME` ve `RUSTUP_HOME`
değerlerini gerçek klasörlerde bırakın. Sonuç: 151 geçti, 4 hata, 7 atlandı.

## Uygulama hatası olabilecekler

### `remote_management_and_targeted_push`

```
Git(Error { code: -1, klass: 7, message: "invalid escape at Users\\sarda\\AppData\\Local\\Temp\\...\\backup.git" })
```

- Yer: `src-tauri/src/git/tests.rs:766`, `ops::rename_remote` çağrısı.
- Test, remote'u `C:\...` biçiminde ters bölülü bir yolla ekliyor
  (`tests.rs:752`). Bu remote'a push ve fetch çalışıyor, yeniden adlandırma
  çalışmıyor.
- `ops.rs:809` doğrudan libgit2'nin `remote_rename` işlevini çağırıyor. Hata
  sınıfı config (7), yani ayar okunurken ya da yazılırken çıkıyor olabilir.
- Doğrulanmadı: asıl neden ve başarısız denemenin `.git/config` dosyasında iz
  bırakıp bırakmadığı.

### `search_history_by_file_and_code`

```
glob chars are literal
```

- Yer: `src-tauri/src/git/tests.rs:1037`.
- Dosya yolu aramasında `*` düz karakter sayılmalı ve sonuç dönmemeli, ama
  sonuç dönüyor.
- Şüphe: `glob_escape` (`history.rs:81`) özel karakterleri ters bölüyle kaçırıyor
  ve bu desen `pathspec` olarak veriliyor (`history.rs:127`). Windows'ta ters
  bölü farklı yorumlanıyor olabilir.
- Doğrulanmadı: asıl neden ve `?`, `[`, `]` karakterlerinin de etkilenip
  etkilenmediği.

## Test sorunu olanlar

### `paths_are_literal_not_globs`

```
Os { code: 123, kind: InvalidFilename, message: "The filename, directory name, or volume label syntax is incorrect." }
```

- Yer: `src-tauri/src/git/tests.rs:835`, panik `tests.rs:68`.
- Test `a*b.txt` adlı bir dosya oluşturuyor. Windows dosya adında `*` kabul
  etmez, bu yüzden test uygulama koduna ulaşmadan düşüyor.
- `*` ile yapılan kontrol bu haliyle Windows'ta çalıştırılamaz. Test
  `#[cfg(not(windows))]` ile kapatılabilir ya da Windows'ta geçerli olan `[` ve
  `]` karakterleriyle yazılabilir.

### `workspace_finds_repositories_in_a_folder`

```
left: ["a", "group\\b"]
right: ["a", "group/b"]
```

- Yer: `src-tauri/src/git/tests.rs:1646`.
- Test göreli yolu `/` ile sabit bir metinle karşılaştırıyor, Windows ise `\`
  döndürüyor. Bulunan repolar doğru.
- Beklenen değer `Path::new("group").join("b")` ile kurulabilir.
