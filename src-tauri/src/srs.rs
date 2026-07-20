use crate::bank::Srs;
use chrono::{Duration, NaiveDate};

/// Review outcome, in Anki's vocabulary.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    pub fn parse(s: &str) -> Option<Grade> {
        match s {
            "again" => Some(Grade::Again),
            "hard" => Some(Grade::Hard),
            "good" => Some(Grade::Good),
            "easy" => Some(Grade::Easy),
            _ => None,
        }
    }
}

const MIN_EASE: f64 = 1.3;
const MAX_INTERVAL: u32 = 365;

/// SM-2 style scheduling (the algorithm behind Anki), simplified to
/// whole-day intervals so it fits a daily writing habit.
pub fn apply(srs: &mut Srs, grade: Grade, today: NaiveDate) {
    match grade {
        Grade::Again => {
            srs.lapses += 1;
            srs.reps = 0;
            srs.interval = 0;
            srs.ease = (srs.ease - 0.20).max(MIN_EASE);
        }
        Grade::Hard => {
            srs.reps += 1;
            srs.interval = ((srs.interval as f64 * 1.2).round() as u32).max(1);
            srs.ease = (srs.ease - 0.15).max(MIN_EASE);
        }
        Grade::Good => {
            srs.reps += 1;
            srs.interval = match srs.reps {
                1 => 1,
                2 => 6,
                _ => ((srs.interval as f64 * srs.ease).round() as u32).max(srs.interval + 1),
            };
        }
        Grade::Easy => {
            srs.reps += 1;
            srs.interval = match srs.reps {
                1 => 2,
                2 => 8,
                _ => ((srs.interval as f64 * srs.ease * 1.3).round() as u32).max(srs.interval + 2),
            };
            srs.ease += 0.15;
        }
    }
    srs.interval = srs.interval.min(MAX_INTERVAL);
    srs.due = today + Duration::days(srs.interval as i64);
    srs.last = Some(today);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn good_reviews_grow_the_interval() {
        let today = day("2026-07-20");
        let mut srs = Srs::new(today);
        apply(&mut srs, Grade::Good, today);
        assert_eq!(srs.interval, 1);
        apply(&mut srs, Grade::Good, today);
        assert_eq!(srs.interval, 6);
        apply(&mut srs, Grade::Good, today);
        assert_eq!(srs.interval, 15); // 6 * 2.5
    }

    #[test]
    fn again_resets_and_reduces_ease() {
        let today = day("2026-07-20");
        let mut srs = Srs::new(today);
        apply(&mut srs, Grade::Good, today);
        apply(&mut srs, Grade::Good, today);
        apply(&mut srs, Grade::Again, today);
        assert_eq!(srs.reps, 0);
        assert_eq!(srs.due, today);
        assert!(srs.ease < 2.5);
    }

    #[test]
    fn ease_never_drops_below_floor() {
        let today = day("2026-07-20");
        let mut srs = Srs::new(today);
        for _ in 0..20 {
            apply(&mut srs, Grade::Again, today);
        }
        assert!(srs.ease >= MIN_EASE);
    }
}
