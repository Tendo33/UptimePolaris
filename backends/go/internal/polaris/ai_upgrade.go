package polaris

import "context"

func (s *Store) upgradeAICheckRevisions(ctx context.Context) error {
	return s.mutate(ctx, func(tx *transaction) error {
		for _, kind := range []string{"ai_channel", "ai_model"} {
			rows, err := tx.list(kind)
			if err != nil {
				return err
			}
			for _, row := range rows {
				if _, present := row["checkRevision"]; present {
					continue
				}
				row["checkRevision"] = row["revision"]
				if err = tx.put(kind, str(row, "id"), row); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
