package polaris

import "sort"

func aggregateMachineHistory(rows []Object, step int64) []Object {
	groups := map[int64][]Object{}
	for _, row := range rows {
		ts := integer(row, "bucket_ts") / step * step
		groups[ts] = append(groups[ts], row)
	}
	out := []Object{}
	for ts, group := range groups {
		average := func(field, weight string) any {
			var sum, samples float64
			for _, row := range group {
				if n := number(row[weight]); row[field] != nil && n > 0 {
					sum += number(row[field]) * n
					samples += n
				}
			}
			if samples == 0 {
				return nil
			}
			return sum / samples
		}
		rate := func(field string) any {
			var bytes, seconds float64
			for _, row := range group {
				if duration := number(row["network_duration_sec"]); row[field] != nil && duration > 0 {
					bytes += number(row[field])
					seconds += duration
				}
			}
			if seconds == 0 {
				return nil
			}
			return bytes / seconds
		}
		out = append(out, Object{"ts": ts, "cpu": average("cpu_avg", "cpu_samples"), "mem_pct": average("mem_pct_avg", "mem_samples"), "net_up": rate("net_up_bytes"), "net_down": rate("net_down_bytes")})
	}
	sort.Slice(out, func(i, j int) bool { return integer(out[i], "ts") < integer(out[j], "ts") })
	if step == 300 && len(out) > 288 {
		out = out[len(out)-288:]
	}
	return out
}
