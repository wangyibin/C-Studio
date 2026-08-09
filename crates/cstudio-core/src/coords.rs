use crate::{CStudioError, CStudioResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interval {
    start: u64,
    end: u64,
}

impl Interval {
    pub fn new(start: u64, end: u64) -> CStudioResult<Self> {
        if start >= end {
            return Err(CStudioError::InvalidInterval { start, end });
        }

        Ok(Self { start, end })
    }

    pub fn start(&self) -> u64 {
        self.start
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    pub fn len(&self) -> u64 {
        self.end - self.start
    }

    pub fn to_agp_interval(&self) -> AgpInterval {
        AgpInterval {
            start: self.start + 1,
            end: self.end,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgpInterval {
    start: u64,
    end: u64,
}

impl AgpInterval {
    pub fn new(start: u64, end: u64) -> CStudioResult<Self> {
        if start == 0 || start > end {
            return Err(CStudioError::InvalidAgpInterval { start, end });
        }

        Ok(Self { start, end })
    }

    pub fn start(&self) -> u64 {
        self.start
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    pub fn to_interval(&self) -> Interval {
        Interval {
            start: self.start - 1,
            end: self.end,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AgpInterval, Interval};

    #[test]
    fn converts_internal_half_open_interval_to_agp_closed_interval() {
        let interval = Interval::new(0, 500).expect("valid interval");

        let agp = interval.to_agp_interval();

        assert_eq!(agp, AgpInterval::new(1, 500).expect("valid AGP interval"));
    }

    #[test]
    fn converts_agp_closed_interval_to_internal_half_open_interval() {
        let agp = AgpInterval::new(101, 250).expect("valid AGP interval");

        let interval = agp.to_interval();

        assert_eq!(interval, Interval::new(100, 250).expect("valid interval"));
    }
}
