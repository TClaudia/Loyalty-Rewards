import React, { useEffect, useState } from 'react';
import { Card, Progress, Button } from '@/components/ui';

const ProgressBar = ({ customerId }) => {
  const [loyaltyData, setLoyaltyData] = useState(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    async function fetchLoyaltyData() {
      const response = await fetch(`/loyalty/customer/${customerId}`);
      const data = await response.json();
      setLoyaltyData(data); // Set the loyalty data
    }
    fetchLoyaltyData();
  }, [customerId]);

  // Ensure loyaltyData is loaded before rendering the progress bar
  if (!loyaltyData) {
    return <div>Loading...</div>;  // You can show a loading message if the data is not yet available
  }

  return (
    <Card className="fixed left-4 bottom-4 p-4 shadow-lg">
      <Button onClick={() => setShow(!show)}>See Your Points</Button>
      {show && (
        <div>
          <Progress value={(loyaltyData.points / 2000) * 100} />
          <p>{loyaltyData.points} / 2000 Points</p>
        </div>
      )}
    </Card>
  );
};

export default ProgressBar;
