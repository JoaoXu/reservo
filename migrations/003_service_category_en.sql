-- English name for a service's category ("Massagens" -> "Massages").
alter table services add column category_en text not null default '';
