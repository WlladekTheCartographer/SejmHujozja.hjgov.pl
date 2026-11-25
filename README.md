# Sejm – aplikacja do głosowań

Ta paczka zawiera nowy `index.html` dla GitHub Pages oraz jedną funkcję Supabase Edge Function (`sejm-api`), która zastępuje wiele nieistniejących funkcji z poprzedniej wersji.

## 1. Wdrożenie strony na GitHub Pages

1. Rozpakuj paczkę.
2. Wgraj `index.html` do repozytorium GitHub, w katalogu publikowanym przez Pages.
3. W `index.html` sprawdź `SUPABASE_URL` i `SUPABASE_KEY`. Adres projektu jest ustawiony na `https://ggckmiocsslbwjtjfqxl.supabase.co`; klucz to publishable/anon key. **Nigdy nie wklejaj `service_role` do HTML.**
4. Włącz GitHub Pages dla repozytorium.

## 2. Wdrożenie funkcji Supabase

Wymagany jest Supabase CLI oraz zalogowanie do właściwego projektu. Z katalogu projektu uruchom:

```sh
supabase login
supabase link --project-ref ggckmiocsslbwjtjfqxl
supabase functions deploy sejm-api
```

Funkcja korzysta z sekretów `SUPABASE_URL`, `SUPABASE_ANON_KEY` i `SUPABASE_SERVICE_ROLE_KEY`, które standardowo są dostępne w środowisku Supabase Edge Functions. Jeśli Twoje środowisko nie udostępnia ich automatycznie, ustaw je przez `supabase secrets set` — nigdy nie umieszczaj ich w pliku HTML ani repozytorium.

## 3. Uprawnienia marszałka

Utwórz użytkownika w Supabase Authentication (e-mail + hasło). Następnie znajdź jego UUID w Authentication → Users i wykonaj w SQL Editor, podstawiając UUID:

```sql
INSERT INTO public.admin_users (user_id)
VALUES ('UUID-MARSZALKA')
ON CONFLICT (user_id) DO NOTHING;
```

Tabela `admin_users` musi zawierać UUID konta marszałka. Logowanie przez stronę samo w sobie nie nadaje uprawnień.

## 4. Ważne uwagi o PIN-ach

- PIN klubu jest weryfikowany w Edge Function; do przeglądarki nie trafia jego hash.
- Przy dodawaniu klubu możesz ustawić PIN.
- Dla istniejącego klubu pozostaw pole PIN puste, aby zachować aktualny PIN. Zaznacz „Usuń PIN”, aby usunąć PIN.
- Przy pierwszym zapisie nowych klubów pole PIN może pozostać puste.

## 5. Bezpieczeństwo i testy przed użyciem

- Zostaw włączone RLS na tabelach.
- Nie dodawaj polityk pozwalających anonimowym użytkownikom zapisywać głosy lub odczytywać surowe wyniki. Funkcja używa klucza service-role po stronie serwera i sprawdza JWT oraz `admin_users` dla akcji marszałka.
- Przetestuj najpierw na danych testowych: dodaj 2 kluby, ustaw PIN jednemu, utwórz głosowanie, oddaj głosy, zamknij i opublikuj.
- Ta wersja zakłada schemat tabel opisany w rozmowie. Jeśli nazwy kolumn lub ograniczenia w Twoim projekcie różnią się, funkcja może wymagać dopasowania.
- Dźwięk jest generowany lokalnie w przeglądarce. Przeglądarki wymagają kliknięcia użytkownika, aby odblokować dźwięk.
- Odliczanie jest realizowane przez znacznik czasu w `app_control`; strona zamyka głosowanie, gdy kolejny request odczyta stan po upływie czasu. Przy długiej przerwie bez odwiedzających strona może nie zmienić statusu dokładnie w sekundzie zero, ale kolejne odświeżenie stanu wykona zamknięcie.
