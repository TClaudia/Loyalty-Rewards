import React, { useEffect, useState } from 'react';
import { Card, Progress, Button } from '@/components/ui';

const ProgressBar = ({ customerId }) => {
  const [points, setPoints] = useState(0);

  useEffect(() => {
    async function fetchPoints() {
      const response = await fetch(`/loyalty/customer/${customerId}`);
      const data = await response.json();
      setPoints(data.points);
    }
    fetchPoints();
  }, []);

  return (
    <Card className="fixed left-4 bottom-4 p-4 shadow-lg">
      <Button onClick={() => setShow(!show)}>See Your Points</Button>
      {show && (
        <div>
          <Progress value={(points / 2000) * 100} />
          <p>{points} / 2000 Points</p>
        </div>
      )}
    </Card>
  );
};

export default ProgressBar;
