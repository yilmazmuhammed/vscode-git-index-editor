# Git Index Editor

[English](README.md) | **Türkçe**

Git staged alanını (Index), Eclipse EGit'in Staging görünümündeki gibi **doğrudan düzenlemenizi**
sağlar. Index gerçek bir editör olarak açılır: içine yazar, yapıştırır ve kaydedersiniz. Kaydettiğiniz
metin commit'e girer; çalışma ağacınız olduğu gibi kalır.

Eklenti VS Code'un yerleşik Git desteğinin yerini almaz, onu tamamlar. Depolar, durum bilgisi ve push
işlemi yerleşik Git eklentisinden gelir. Arayüz Türkçe ve İngilizcedir; hangisinin gösterileceği VS
Code'un dil ayarına göre seçilir.

## Git Staging görünümü

Etkinlik çubuğundaki **Git Staging** simgesi üç bölümlük bir görünüm açar:

| Bölüm | İçerik |
| --- | --- |
| **Unstaged Değişiklikler** | Çalışma ağacındaki değişiklikler, untracked dosyalar ve çakışmalar |
| **Staged Değişiklikler** | Index'teki, yani commit'e girecek değişiklikler |
| **Commit Mesajı** | Mesaj, Amend, Sign-off, Author, Committer, Commit ve Commit and Push |

- Dosyalar sürükle-bırakla listeler arasında taşınabilir. Çoklu seçim yapılabilir.
- Satır içi `+` ve `−` düğmeleri dosyayı stage ve unstage eder.
- Hem staged hem unstaged değişikliği olan dosya iki listede birden görünür ve *kısmen staged* olarak işaretlenir.
- Başlık çubuğunda şu düğmeler vardır: tümünü ekle/çıkar, untracked dosyaları göster/gizle, filtre, yenile. `…` menüsünde sunum (liste, ağaç, kompakt ağaç) ve sıralama seçenekleri bulunur.
- Filtre yolun bir parçasıyla eşleşir; `*` herhangi bir metne, `?` tek bir karaktere karşılık gelir. Başlıkta görünen/toplam sayısı yazar.
- Birden fazla depo açıksa görünüm, etkin editör sekmesinin (diff'ler dahil her tür editör) ve Source Control görünümünde seçtiğiniz deponun ardından gider. İki liste ve commit alanı, üzerinde çalıştıkları depoyu ve dalı gösterir.
- VS Code, Gezgin'de seçili dosya veya klasörü eklentilere bildirmez. Bu yüzden bir klasör ancak sağ tıklayıp **Git Staging'de Göster** dediğinizde dikkate alınır. Gezgin'de bir dosyaya tıklamak onu açtığı için görünüm onu izler. Depo başlık çubuğundan da seçilebilir.

**Bağlam menüsü** (EGit'teki gibi): Index'e ekle/çıkar, çalışma ağacı sürümünü aç, HEAD ile
karşılaştır, birbiriyle karşılaştır, Index'teki dosyayla değiştir, HEAD sürümüyle değiştir,
Ours/Theirs ile değiştir, merge aracı, yoksay, klasörü yoksay, sil, assume unchanged, untrack, yolu
kopyala, Gezgin'de göster.

- Assume-unchanged işaretini kaldırmak için Unstaged görünümünün `…` menüsünde **Assume Unchanged'i Kaldır…** komutu vardır.
- Bu işaretli dosyalar Gezgin'de `AU` ile gösterilir.

## Git Depoları görünümü

Git Staging kabının ilk bölümü, EGit'teki Git Repositories görünümü gibi açık depoları listeler:

| Düğüm | Gösterdiği | Eylemler |
| --- | --- | --- |
| **Depo** | Dal, ↑önde ↓geride ve MERGING / REBASING | Fetch, Şuradan Fetch…, Pull, Pull…, Upstream'e Push, Dalı Push Et…, Push…, Dala Geç…, Dal Oluştur…, Dalı Yapılandır…, Remote Oluştur…, Git Staging'de Göster, Yolu Kopyala |
| **Dallar › Yerel** | Dallar, her `/` işaretinde klasörlere ayrılmış ya da liste hâlinde; upstream ve ↑↓ | Checkout, Dal Oluştur…, Yeniden Adlandır (F2), Sil (Del, birden çok), Dalı Yapılandır…, Dalı Push Et… |
| **Dallar › Remote Tracking** | Remote-tracking dallar | Checkout (onu izleyen yerel dal olarak), Dal Oluştur…, Dalı Remote'ta Sil |
| **Referanslar** | HEAD, FETCH_HEAD, ORIG_HEAD, MERGE_HEAD… | Checkout (detached), Dal Oluştur… |
| **Remote'lar** | Her remote, Fetch ve Push URL'leri ve refspec'leriyle | Fetch, Push…, Remote'u Yapılandır…, Yeniden Adlandır, Sil |

- **Birden çok depo seçildiğinde** Fetch, Pull ve Dala Geç hepsinde çalışır. Pull, aynı anda birkaç depoyu günceller (`indexEditor.repositories.pullConcurrency`).
- **Dala Geç…** önce son checkout edilen dalları listeler; bunlar reflog'dan okunur.
- **Dal Oluştur…** herhangi bir dal, tag ya da commit'ten başlar ve ad önerir. Remote bir dalı merge veya rebase ile izleyebilir.
- **Dalı Yapılandır…** upstream remote'u, dalı ve pull modunu ayarlar ya da upstream'i kaldırır.
- **Checkout'u yerel değişiklikler engellerse** şu seçenekler sunulur:
  - **Akıllı Checkout**: staged ve unstaged değişikliklerinizi, untracked dosyalar dahil, diğer dala taşır. Önce sınar: o dalla çakışacaklarsa hiçbir şey değişmez ve değişiklikleriniz yerinde, bulunduğunuz dalda kalırsınız.
  - **Önce Commit Et…**: işlemi durdurur ve commit alanını açar.
  - **Değişiklikleri Atıp Checkout**: değişiklikleri atar.
- **Fetch** hangi remote-tracking dalların güncellendiğini, eklendiğini ya da silindiğini bildirir.
- **Pull…** bir remote'un dalını getirir, üzerine merge ya da rebase yapar ve onu upstream yapabilir. Git çakışmalarda durursa çakışmalar Staging görünümünde görünür.
- **Dalı Push Et…** remote'u, uzak dal adını, upstream modunu ve force-with-lease push yapılıp yapılmayacağını sorar.
- **Push…** refspec alır. `:refs/heads/eski` gibi bir refspec uzak dalı siler. **Dry Run** sonucu terminalde gösterir.
- **Remote'u Yapılandır…** bir editör açar. Editörde URL, push URL'leri, fetch ve push refspec'leri, tag getirme ve prune ayarları ile Kaydet, Kaydet ve Fetch, Kaydet ve Push ve Dry Run düğmeleri bulunur.
- Fetch, pull ve push yerleşik Git eklentisi üzerinden yapılır; kimlik bilgilerini VS Code her zamanki gibi sorar.
- Başlık çubuğu dalları hiyerarşik ya da düz gösterir. `…` menüsü her dalın son commit'ini gösterir ve Editörle Bağla'yı açıp kapatır.

## Index'i düzenleme

Bir dosyaya tıklayınca, sağ tarafında **düzenlenebilir Index** olan bir karşılaştırma editörü açılır:

| Tıklanan liste | Sol taraf | Sağ taraf |
| --- | --- | --- |
| **Unstaged** | Çalışma ağacı (o da düzenlenebilir) | Index |
| **Staged** | Taban: HEAD ya da upstream dalı (salt okunur) | Index |

Index her zaman sağdadır. Bu yüzden kenardaki ok her zaman "bu bloğu Index'e al" anlamına gelir:

- Unstaged karşılaştırmada ok bloğu **stage eder**.
- Staged karşılaştırmada ok bloğu tabandan geri alır; taban HEAD ise bloğu **unstage eder**.
- Index tarafına elle istediğiniz metni yazabilirsiniz. <kbd>Ctrl</kbd>+<kbd>S</kbd> bu metni doğrudan Index'e yazar; çalışma ağacındaki dosya değişmez.

Diğer komutlar:

- **Hunk'ı veya Seçili Satırları Stage Et / Unstage Et**: imleçteki hunk'ı ya da seçili satırları Index'e taşır. Kısayolu <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>; ayrıca editör başlığındaki `+`/`−` düğmesinden ve bağlam menüsünden çalışır.
- **Hunk'ı veya Seçili Satırları Çalışma Ağacından At**: değişikliği çalışma ağacı belgesinde geri alır ama kaydetmez.
- **Tabanı HEAD ile Upstream Arasında Değiştir** (başlıktaki dal simgesi): staged karşılaştırmanın tabanını değiştirir. Varsayılanı `indexEditor.staging.stagedCompareBase` ayarı belirler. Upstream yoksa HEAD kullanılır.
- **Tüm Dosyayı Stage Et**, **Index'i Tabana Döndür** ve **Index'i Yeniden Yükle**: editör başlığının `…` menüsündedir.
- <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> iki karşılaştırma arasında geçiş yapar.

Aynı editörlere VS Code'un kendi Source Control listesinden de ulaşabilirsiniz. Dosyaya sağ tıklayıp
**Index'i Düzenle: …** komutunu seçin. Gezgin'de ve açık bir dosyanın başlık menüsünde de aynı komutlar vardır.

## Commit alanı

- **Mesaj**
  - Mesaj alanının altında özet satırının uzunluğu yazar. İkinci satır boş değilse uyarı çıkar.
  - Alan şu öncelikle önceden doldurulur: kaydedilmemiş taslak, Git'in merge için hazırladığı mesaj, `commit.template`.
  - **Önceki Mesajlar** bağlantısı eski commit mesajlarını listeler.
- **Seçenekler**
  - **Amend**: son commit'in mesajını yükler. HEAD zaten bir remote dalda ise uyarır.
  - **Sign-off**: mesaja `Signed-off-by` satırı ekler.
  - **Author / Committer** alanlarının varsayılanı git config'teki kimliktir. Daha önce kullanılan değerler öneri olarak gelir.
- **Düğmeler**
  - **Commit** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) yalnızca Index'tekini commit eder.
  - **Commit and Push** commit'ten sonra dalı upstream'ine push eder. Upstream yoksa dalı bir remote'a yayımlar.
  - Commit edilecek bir şey yoksa bu düğme **HEAD'i Push Et** olur.
- **Merge veya rebase sürerken** alanın üstünde bir şerit çıkar. Şeritte **Devam** (rebase) ve **İptal** düğmeleri bulunur.
- `indexEditor.commit.problemCheck` ayarı açılırsa, staged dosyalarda hata veya uyarı varken commit'ten önce sorulur ya da commit engellenir.
- Kaydedilmemiş Index belgesi varken commit etmeye çalışırsanız, önce onları kaydetmeniz istenir.
- **Commit** ve **Commit (Amend)** komutları komut paletinden ve kısayollardan da çalışır; commit alanındaki mesajı kullanır.

## 0.1.0'dan gelenler için

- Komut kimlikleri ve ayar adları yine `indexEditor.*` biçimindedir; 0.1.0'daki komutlara bağlı kısayollar çalışmaya devam eder.
- 0.1.0'daki ayrı **Git Index** Source Control girdisi kaldırıldı; yerini Git Staging görünümü aldı.
- `indexEditor.unstagedDiffLayout` ayarı kaldırıldı; Index her zaman sağdadır.

## Yalnızca yan yana görünüm

Index editörleri yalnızca yan yana karşılaştırma görünümünde çalışır. Eklenti şu varsayılanları
ayarlar (kendi ayarınızla değiştirebilirsiniz):

```json
"diffEditor.renderSideBySide": true,
"diffEditor.useInlineViewWhenSpaceIsLimited": false
```

Satır içi görünüm açıkken:

- Karşılaştırmalar açılmaz.
- Açık bir karşılaştırmanın Index tarafı salt okunur olur.
- Kaydedilmemiş düzenlemeler korunur.

## Ayarlar

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| `indexEditor.staging.stagedCompareBase` | `HEAD` | Staged dosyanın Index'inin karşılaştırıldığı taban. Diğer değeri `upstream`. |
| `indexEditor.staging.presentation` | `list` | Listeleme biçimi: `list`, `tree` veya `compactTree`. |
| `indexEditor.staging.sortBy` | `name` | Sıralama: `name` (yola göre) veya `status` (değişiklik türüne göre). |
| `indexEditor.staging.showUntracked` | `true` | Untracked dosyalar gösterilsin mi. |
| `indexEditor.staging.followActiveEditor` | `true` | Görünüm etkin editörün ve Source Control seçiminin deposunu izlesin mi. |
| `indexEditor.repositories.hierarchicalBranches` | `true` | Dallar her `/` işaretinde klasörlere ayrılsın mı, yoksa liste mi olsun. |
| `indexEditor.repositories.showLatestCommit` | `false` | Her dalın yanında son commit'i gösterilsin mi. |
| `indexEditor.repositories.linkWithEditor` | `true` | Git Depoları görünümü etkin editörün deposunu seçsin mi. |
| `indexEditor.repositories.pullConcurrency` | `3` | Pull'un aynı anda kaç depoyu güncelleyeceği. |
| `indexEditor.commit.signOffByDefault` | `false` | Sign-off varsayılan olarak işaretli gelsin mi. |
| `indexEditor.commit.problemCheck` | `off` | Commit öncesi sorun denetimi: `off`, `warn` veya `block`. |
| `indexEditor.commit.problemSeverity` | `error` | Denetimde sayılacak en düşük düzey: `error` veya `warning`. |
| `indexEditor.commit.messageHistorySize` | `20` | Hatırlanacak mesaj, author ve committer sayısı. |
| `indexEditor.decorations.assumeUnchanged` | `true` | Assume-unchanged dosyalar Gezgin'de `AU` ile gösterilsin mi. |

## Bilinmesi gerekenler

- **Kaydetme eylemleri Ctrl+S'te çalışır.** Bir Index belgesini kaydederken `files.trimTrailingWhitespace` ve `editor.formatOnSave` gibi ayarlar uygulanır. Stage ve unstage komutları Index'e doğrudan yazar; bu ayarlardan etkilenmez.
- **`files.autoSave` açıksa** Index belgesi her otomatik kayıtta Index'e yazılır.
- **Satır sonları.** Index'te zaten olan bir dosyanın içeriği bayt bayt saklanır; `core.autocrlf` açıkken bile Index'te LF kalır. Index'e ilk kez giren dosya Git'in clean filtrelerinden geçer.
- **Çakışmalı dosyalar** merge editöründe açılır. Böyle bir dosyanın Index'i düzenlenemez. Çakışmayı çözüp dosyayı Index'e ekleyin.
- **Submodule'ler ve binary dosyalar** salt okunur açılır.
- `diffEditor.useInlineViewWhenSpaceIsLimited` ayarını yeniden açarsanız, dar bir editör kendiliğinden satır içi görünüme geçebilir. VS Code eklentilerin bunu algılamasına izin vermez; bu durumda Index düzenlenebilir kalır.

## Gereksinimler

- Git 2.25 veya üstü.
- VS Code 1.100 veya üstü. Yerleşik Git eklentisi etkin olmalıdır.

## Geliştirme

```powershell
npm install
npm run test:unit
$env:VSCODE_EXECUTABLE = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"; npm run test:integration
npx @vscode/vsce package
```

`VSCODE_EXECUTABLE` verilirse entegrasyon testleri kurulu VS Code ile çalışır ve indirme yapmaz. Bu
kapalı ağda gereklidir.

## Yayımlama

`main` dalına yapılan her push, [.github/workflows/publish.yml](.github/workflows/publish.yml) iş
akışını çalıştırır. İş akışı birim testlerini koşar. `package.json`'daki sürüm marketplace'teki
sürümden farklıysa eklentiyi Trusted Publishing (OIDC) ile, erişim anahtarı (PAT) olmadan yayımlar.
Yeni bir sürüm yayımlamak için `package.json`'daki `version` alanını artırıp `CHANGELOG.md`'yi
güncellemek yeterlidir.
