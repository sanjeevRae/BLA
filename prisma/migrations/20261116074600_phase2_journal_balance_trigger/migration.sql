-- Phase 2 (V2) hardening: the journal-balance invariant moves from a
-- service-level assertion in postJournal to a database-enforced rule
-- (audit Appendix C, adopted from the independent ChatGPT/Gemini
-- reviews). A deferred constraint trigger checks, at COMMIT time,
-- that every journalRef touched by the transaction satisfies
-- Σ DEBIT = Σ CREDIT across ALL of its LedgerTransaction rows.
--
-- Deferred, so a journal's legs may be inserted in any order inside
-- one transaction. Whole-ref, so a later append to an existing
-- journalRef (the COD reject → re-submit cycle re-posts under the
-- same ref after a reversal) must keep the running total balanced
-- too. postJournal remains the only writer and still asserts balance
-- up front; this trigger is the backstop that no code path — present
-- or future — can bypass.

CREATE OR REPLACE FUNCTION "app"."assert_journal_balanced"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  debit_total bigint;
  credit_total bigint;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountPaisa" ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountPaisa" ELSE 0 END), 0)
  INTO debit_total, credit_total
  FROM "app"."LedgerTransaction"
  WHERE "journalRef" = NEW."journalRef";

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'Journal % is unbalanced: debits % != credits %',
      NEW."journalRef", debit_total, credit_total;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LedgerTransaction_journal_balanced"
  AFTER INSERT ON "app"."LedgerTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "app"."assert_journal_balanced"();
